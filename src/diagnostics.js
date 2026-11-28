/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Diagnostics: a small persistent log plus a plain-text report a user can copy
 * or save and send when something does not behave.
 *
 * Pure and free of extension APIs, like matcher.js. The background script owns
 * storage and gathers the environment; this module only shapes text.
 *
 * Privacy is the design constraint. The report is written to be pasted into an
 * email or a public GitHub issue, so by default it carries no addresses, no
 * domains, no patterns, no folder names, and no rule names: only the shape of
 * each rule and what the engine did. A rule name counts as a value because a
 * rule made from a message is named after its sender or its subject. The user can opt in to values when they want to share
 * them, and the options page shows the exact text before it leaves.
 */

import {
  AGE_OPERATORS,
  DOMAIN_IN_LIST,
  IN_ADDRESS_BOOK,
  NAME_SHOWS_OTHER_ADDRESS,
  SIZE_OPERATORS,
  STATE_LABELS,
  fieldsOf,
  isAgeCondition,
  isAuthCondition,
  isPriorityCondition,
  isSizeCondition,
  isStateCondition,
  isTagCondition,
} from './matcher.js';
import { actionsOf, orderActions } from './actions.js';
import { ADVANCED_DEFAULTS, trustedServerList } from './settings.js';
import { nextRun, scheduleOf } from './cron.js';

/** Most recent log entries kept. At a 2-minute interval that is several hours. */
export const LOG_CAP = 1000;
const MAX_MESSAGE_CHARS = 500;

function formatArg(arg) {
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg && typeof arg === 'object') {
    if (typeof arg.message === 'string') return arg.message;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

/**
 * Marks around a part of a log line that the report hides unless the user
 * includes values: a rule name or a folder id. The log keeps both forms, so
 * the choice is made when the report is built, also for a rule that was
 * renamed or deleted after the line was written. The marks are private-use
 * code points, and `sensitive` removes them from the text it wraps.
 */
const HIDE_START = '\uE000';
const HIDE_MIDDLE = '\uE001';
const HIDE_END = '\uE002';
const HIDE_MARKS = /[\uE000-\uE002]/g;
// A line cut at MAX_MESSAGE_CHARS can end inside a span, so the end is optional.
const HIDE_SPAN = /\uE000([^\uE000-\uE002]*)(?:\uE001([^\uE000-\uE002]*))?(?:\uE002|$)/g;
const HIDDEN = '(hidden)';

/** `value` for a log line, shown as `standIn` in a report without values. */
export function sensitive(value, standIn = HIDDEN) {
  const clean = (text) => String(text ?? '').replace(HIDE_MARKS, '');
  return `${HIDE_START}${clean(value)}${HIDE_MIDDLE}${clean(standIn)}${HIDE_END}`;
}

/** The first 8 characters of a rule id, as the report prints it. */
const shortId = (id) => String(id ?? '?').slice(0, 8);

/**
 * A rule in a log line: its quoted name, or its short id in a report without
 * values. The rule list of the report prints the same id.
 */
export function ruleRef(rule) {
  return sensitive(`"${rule?.name ?? ''}"`, rule?.id ? `[${shortId(rule.id)}]` : '[not saved]');
}

/** A folder id in a log line. The id holds the folder path. */
export const folderRef = (folderId) => sensitive(folderId, '(folder)');

/** Log text with each marked part as its value or as its stand-in. */
export function revealText(text, includeValues) {
  return String(text ?? '').replace(HIDE_SPAN, (_, value, standIn) => (includeValues ? value : standIn ?? HIDDEN));
}

/**
 * Hide rule names and folder ids in a line written before the log marked
 * them. A known rule name becomes its short id. Any other quoted name after
 * "rule" or "dry run" is cut up to the last quote of the line, so a name that
 * holds a quote can't show through.
 */
function hideUnmarked(text, rules) {
  let out = String(text ?? '');
  const named = rules.filter((r) => String(r?.name ?? '') !== '').sort((a, b) => b.name.length - a.name.length);
  for (const rule of named) out = out.split(`"${rule.name}"`).join(`[${shortId(rule.id)}]`);
  return out
    .replace(/\b(failed for folder ).*?(?=( in rule )|$)/g, '$1(folder)')
    .replace(/\b(rule|dry run) ".*"/g, '$1 [name hidden]');
}

/**
 * What the header or body reads of one run cost, for the log. Empty when the
 * run made no such read, so a run over indexed fields keeps a short line.
 */
export function describeReads(label, reads) {
  if (!reads) return '';
  const { fresh = 0, cached = 0, timeouts = 0, skipped = 0 } = reads;
  if (fresh + cached + timeouts + skipped === 0) return '';
  const parts = [`${fresh} in ${Math.round(reads.spentMs ?? 0)} ms`];
  if (fresh > 0) parts.push(`slowest ${Math.round(reads.slowestMs ?? 0)} ms`);
  if (cached > 0) parts.push(`${cached} from cache`);
  if (timeouts > 0) parts.push(`${timeouts} with no answer`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (reads.budgetReached) parts.push('time budget reached');
  return `; ${label}: ${parts.join(', ')}`;
}

/** One log entry from console-style arguments. */
export function makeEntry(level, args, now = new Date()) {
  let msg = (args ?? []).map(formatArg).join(' ');
  if (msg.length > MAX_MESSAGE_CHARS) msg = `${msg.slice(0, MAX_MESSAGE_CHARS)}…`;
  return { t: now.toISOString(), level: level === 'warn' ? 'warn' : 'info', msg };
}

/** Append, keeping only the most recent `cap` entries. Never mutates. */
export function appendEntries(existing, entries, cap = LOG_CAP) {
  const all = [...(Array.isArray(existing) ? existing : []), ...(entries ?? [])];
  return all.length > cap ? all.slice(all.length - cap) : all;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * A time in the user's local zone with its UTC offset, such as
 * "2026-10-15 23:38:36 +02:00". The offset keeps a shared report exact. Takes a
 * Date or an ISO string; anything unreadable comes back as text unchanged.
 * `offsetMinutes` follows getTimezoneOffset(): minutes behind UTC.
 */
export function formatLocalTime(time, offsetMinutes) {
  const date = time instanceof Date ? time : new Date(time);
  if (time == null || Number.isNaN(date.getTime())) return String(time ?? '?');
  const offset = offsetMinutes ?? date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60_000);
  const sign = offset > 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/**
 * One log line of the report. Without `includeValues`, rule names and folder
 * ids are replaced: see `sensitive` and `hideUnmarked`.
 */
export function formatEntry(entry, offsetMinutes, { includeValues = false, rules = [] } = {}) {
  const t = entry?.t == null ? '?' : formatLocalTime(entry.t, offsetMinutes);
  const raw = String(entry?.msg ?? '');
  let msg = revealText(raw, includeValues);
  if (!includeValues && !raw.includes(HIDE_START)) msg = hideUnmarked(raw, rules);
  return `${t} ${entry?.level === 'warn' ? 'WARN' : 'info'} ${msg}`;
}

const AGE_LABELS = { [AGE_OPERATORS.olderThan]: 'older than', [AGE_OPERATORS.newerThan]: 'newer than' };
const SIZE_LABELS = { [SIZE_OPERATORS.largerThan]: 'larger than', [SIZE_OPERATORS.smallerThan]: 'smaller than' };

/** One condition as text. Values are replaced by their length unless opted in. */
export function describeCondition(c, { includeValues = false } = {}) {
  const not = c?.negate ? 'not ' : '';
  if (isAgeCondition(c)) {
    return `age ${not}${AGE_LABELS[c.operator] ?? c.operator} ${c.days} day(s)`;
  }
  if (isSizeCondition(c)) {
    return `size ${not}${SIZE_LABELS[c.operator] ?? c.operator} ${c.size} ${c.unit}`;
  }
  if (isStateCondition(c)) {
    return `${not}${STATE_LABELS[String(c.field).toLowerCase()]?.[c.operator] ?? c.operator}`;
  }
  // A tag key is a value, like a tag in an action.
  if (isTagCondition(c)) return `${not}has tag ${includeValues ? c.tagKey : '(tag)'}`;
  // One of five fixed levels, so there is nothing to hide.
  if (isPriorityCondition(c)) return `priority ${c?.negate ? 'is not' : 'is'} ${c.value}`;
  // spf, dkim, or dmarc: a fixed choice too.
  if (isAuthCondition(c)) return `${c.value} ${c?.negate ? 'does not pass' : 'passes'}`;
  const fields = fieldsOf(c).join(' or ') || '(no field)';
  if (c?.operator === DOMAIN_IN_LIST) {
    const domains = Array.isArray(c.domains) ? c.domains : [];
    const detail = includeValues ? `: ${domains.join(', ')}` : '';
    return `${fields} ${not}domain in list of ${domains.length}${detail}`;
  }
  if (c?.operator === IN_ADDRESS_BOOK) {
    return `${fields} ${not}in address book ${c.addressBookId === 'all' ? '(all)' : `id ${c.addressBookId}`}`;
  }
  if (c?.operator === NAME_SHOWS_OTHER_ADDRESS) return `${fields} ${not}name shows a different address`;
  const value = String(c?.value ?? '');
  const shown = includeValues ? JSON.stringify(value) : `<${value.length} chars>`;
  return `${fields} ${not}${c?.operator} ${shown}`;
}

/** One action as text. Folder ids and tag keys are values, so they are hidden too. */
export function describeAction(a, { includeValues = false } = {}) {
  const type = a?.type ?? '?';
  if (a?.folderId) return `${type} -> ${includeValues ? a.folderId : '(folder)'}`;
  if (a?.tagKey) return `${type} -> ${includeValues ? a.tagKey : '(tag)'}`;
  return type;
}

function describeRule(rule, runState, { includeValues, generatedAt, offsetMinutes, position }) {
  const lines = [];
  const status = rule.enabled === false ? 'disabled' : 'enabled';
  // The id links the rule to its log lines, which print the same 8 characters.
  lines.push(`- ${includeValues ? `"${rule.name}"` : `rule ${position}`} [${status}] id ${shortId(rule.id)}`);
  const folders = Array.isArray(rule.folderIds) ? rule.folderIds : [];
  const subs = rule.includeSubfolders === true ? ' and their subfolders' : '';
  lines.push(`    folders: ${folders.length}${subs}${includeValues && folders.length ? ` (${folders.join(', ')})` : ''}`);
  lines.push(`    match: ${rule.match === 'all' ? 'all (AND)' : 'any (OR)'}`);
  for (const c of rule.conditions ?? []) lines.push(`    if ${describeCondition(c, { includeValues })}`);
  // In execution order, which is what the engine will actually do, not the
  // order they happen to be stored in.
  for (const a of orderActions(actionsOf(rule))) {
    lines.push(`    then: ${describeAction(a, { includeValues })}`);
  }
  if (rule.stopProcessing === true) {
    lines.push('    stop later rules: yes');
  }
  if (rule.schedule?.enabled === true) {
    const cron = scheduleOf(rule);
    // The next run is worked out here because the log leaves routine runs on
    // a rule schedule out by default.
    const next = cron ? nextRun(cron, generatedAt) : null;
    lines.push(
      cron
        ? `    schedule: cron ${cron.expression}; next run: ${next ? formatLocalTime(next, offsetMinutes) : 'never'}`
        : '    schedule: invalid cron, the default timer applies',
    );
  }
  const state = runState?.[rule.id];
  const lastRun = state?.lastRunAt ? formatLocalTime(state.lastRunAt, offsetMinutes) : 'never';
  const lastCatchUp = state?.lastCatchUpAt ? formatLocalTime(state.lastCatchUpAt, offsetMinutes) : 'never';
  const statusNote = state?.lastStatus
    ? `; last outcome: ${state.lastStatus.matched} matched, ${state.lastStatus.affected} actioned${state.lastStatus.error ? ' (with errors)' : ''}`
    : '';
  lines.push(`    last run: ${lastRun}; last catch-up: ${lastCatchUp}${statusNote}`);
  return lines;
}

/** The trusted servers name your provider, so they are a value. */
function describeTrusted(text, includeValues) {
  const servers = trustedServerList(text);
  if (servers.length === 0) return 'none set, the topmost header is trusted';
  return includeValues ? servers.join(', ') : `${servers.length} set`;
}

/**
 * The full plain-text report.
 *
 * @param {object} input
 * @param {string} input.version         extension version
 * @param {object} [input.browser]       runtime.getBrowserInfo() result
 * @param {object} [input.platform]      runtime.getPlatformInfo() result
 * @param {object} input.config          stored config
 * @param {object} input.runState        per-rule run state
 * @param {object} [input.alarm]         the scheduled alarm, if any
 * @param {object} [input.permissions]   { addressBooks, messagesTagsList, dnsServer }, each a boolean
 * @param {Array}  input.entries         log entries, oldest first
 * @param {boolean} [input.includeValues]
 * @param {Date}   [input.generatedAt]
 */
export function buildReport(input) {
  const {
    version,
    browser,
    platform,
    config,
    runState,
    alarm,
    permissions,
    entries,
    includeValues = false,
    generatedAt = new Date(),
    // Minutes behind UTC, as getTimezoneOffset() gives it. Tests fix it; the
    // background script leaves it out, so times use the local zone.
    offsetMinutes,
  } = input ?? {};

  const rules = Array.isArray(config?.rules) ? config.rules : [];
  // Advanced settings are timings, never user content, so they are always shown.
  const adv = { ...ADVANCED_DEFAULTS, ...(config?.advanced ?? {}) };
  const lines = [
    'Folder Filter Scheduler diagnostics',
    `generated: ${formatLocalTime(generatedAt, offsetMinutes)}`,
    `extension: ${version ?? '?'}`,
    `thunderbird: ${browser ? `${browser.name ?? ''} ${browser.version ?? ''}`.trim() : '?'}`,
    `platform: ${platform ? `${platform.os ?? '?'} ${platform.arch ?? ''}`.trim() : '?'}`,
    `values included: ${includeValues ? 'yes' : 'no (addresses, domains, patterns, folders and rule names are hidden)'}`,
    '',
    `interval: every ${config?.intervalMinutes ?? '?'} min`,
    `next scheduled run: ${alarm?.scheduledTime ? formatLocalTime(new Date(alarm.scheduledTime), offsetMinutes) : 'none scheduled'}`,
    `run on new mail: ${adv.runOnNewMail ? `yes, ${adv.newMailDelaySeconds}s after the last arrival` : 'no'}`,
    `scan overlap: ${adv.scanOverlapMinutes} min`,
    `catch-up: every ${adv.catchUpEveryMinutes} min over the last ${adv.catchUpLookbackDays} day(s)`,
    `rule schedule runs in the log: ${adv.logScheduleRuns ? 'all' : 'only those that change mail or fail'}`,
    `right-click menu: ${adv.showMenu ? 'shown' : 'hidden'}; name: ${adv.shortName ? 'FFS' : 'full'}`,
    `address book access: ${permissions?.addressBooks ? 'granted' : 'not granted'}`,
    `tag list access: ${permissions?.messagesTagsList ? 'granted' : 'not granted'}`,
    `own DKIM check: ${adv.authOwnCheck ? `on, DNS server ${adv.authDohServer} (${permissions?.dnsServer ? 'granted' : 'not granted'})` : 'off'}`,
    `when the checks disagree: use the ${adv.authPrefer === 'provider' ? "provider's header" : 'own result'}`,
    `trusted authentication servers: ${describeTrusted(adv.authTrustedServers, includeValues)}`,
    `protected domains: ${Array.isArray(config?.allowlist) ? config.allowlist.length : '?'}`,
    '',
    `rules (${rules.length}):`,
    ...rules.flatMap((r, index) =>
      describeRule(r, runState, { includeValues, generatedAt, offsetMinutes, position: index + 1 }),
    ),
    '',
    `log (last ${entries?.length ?? 0} entries, oldest first):`,
    ...(entries ?? []).map((entry) => formatEntry(entry, offsetMinutes, { includeValues, rules })),
  ];
  return `${lines.join('\n')}\n`;
}

/** `ffs-diagnostics-YYYY-MM-DD-HHMM.txt` in local time, like exportFilename(). */
export function diagnosticsFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `ffs-diagnostics-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.txt`;
}
