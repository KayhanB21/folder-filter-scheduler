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
 * domains, no patterns, and no folder names: only the shape of each rule and
 * what the engine did. The user can opt in to values when they want to share
 * them, and the options page shows the exact text before it leaves.
 */

import { AGE_OPERATORS, DOMAIN_IN_LIST, IN_ADDRESS_BOOK, fieldsOf, isAgeCondition } from './matcher.js';
import { actionsOf, orderActions } from './actions.js';
import { ADVANCED_DEFAULTS } from './settings.js';

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

export function formatEntry(entry) {
  return `${entry?.t ?? '?'} ${entry?.level === 'warn' ? 'WARN' : 'info'} ${entry?.msg ?? ''}`;
}

const AGE_LABELS = { [AGE_OPERATORS.olderThan]: 'older than', [AGE_OPERATORS.newerThan]: 'newer than' };

/** One condition as text. Values are replaced by their length unless opted in. */
export function describeCondition(c, { includeValues = false } = {}) {
  const not = c?.negate ? 'not ' : '';
  if (isAgeCondition(c)) {
    return `age ${not}${AGE_LABELS[c.operator] ?? c.operator} ${c.days} day(s)`;
  }
  const fields = fieldsOf(c).join(' or ') || '(no field)';
  if (c?.operator === DOMAIN_IN_LIST) {
    const domains = Array.isArray(c.domains) ? c.domains : [];
    const detail = includeValues ? `: ${domains.join(', ')}` : '';
    return `${fields} ${not}domain in list of ${domains.length}${detail}`;
  }
  if (c?.operator === IN_ADDRESS_BOOK) {
    return `${fields} ${not}in address book ${c.addressBookId === 'all' ? '(all)' : `id ${c.addressBookId}`}`;
  }
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

function describeRule(rule, runState, { includeValues }) {
  const lines = [];
  const status = rule.enabled === false ? 'disabled' : 'enabled';
  lines.push(`- "${rule.name}" [${status}] id ${String(rule.id ?? '?').slice(0, 8)}`);
  const folders = Array.isArray(rule.folderIds) ? rule.folderIds : [];
  lines.push(`    folders: ${folders.length}${includeValues && folders.length ? ` (${folders.join(', ')})` : ''}`);
  lines.push(`    match: ${rule.match === 'all' ? 'all (AND)' : 'any (OR)'}`);
  for (const c of rule.conditions ?? []) lines.push(`    if ${describeCondition(c, { includeValues })}`);
  // In execution order, which is what the engine will actually do, not the
  // order they happen to be stored in.
  for (const a of orderActions(actionsOf(rule))) {
    lines.push(`    then: ${describeAction(a, { includeValues })}`);
  }
  const state = runState?.[rule.id];
  lines.push(`    last run: ${state?.lastRunAt ?? 'never'}; last catch-up: ${state?.lastCatchUpAt ?? 'never'}`);
  return lines;
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
 * @param {object} [input.permissions]   { addressBooks: boolean, messagesTagsList: boolean }
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
  } = input ?? {};

  const rules = Array.isArray(config?.rules) ? config.rules : [];
  // Advanced settings are timings, never user content, so they are always shown.
  const adv = { ...ADVANCED_DEFAULTS, ...(config?.advanced ?? {}) };
  const lines = [
    'Folder Filter Scheduler diagnostics',
    `generated: ${generatedAt.toISOString()}`,
    `extension: ${version ?? '?'}`,
    `thunderbird: ${browser ? `${browser.name ?? ''} ${browser.version ?? ''}`.trim() : '?'}`,
    `platform: ${platform ? `${platform.os ?? '?'} ${platform.arch ?? ''}`.trim() : '?'}`,
    `values included: ${includeValues ? 'yes' : 'no (addresses, domains, patterns and folders are hidden)'}`,
    '',
    `interval: every ${config?.intervalMinutes ?? '?'} min`,
    `next scheduled run: ${alarm?.scheduledTime ? new Date(alarm.scheduledTime).toISOString() : 'none scheduled'}`,
    `run on new mail: ${adv.runOnNewMail ? `yes, ${adv.newMailDelaySeconds}s after the last arrival` : 'no'}`,
    `scan overlap: ${adv.scanOverlapMinutes} min`,
    `catch-up: every ${adv.catchUpEveryMinutes} min over the last ${adv.catchUpLookbackDays} day(s)`,
    `address book access: ${permissions?.addressBooks ? 'granted' : 'not granted'}`,
    `tag list access: ${permissions?.messagesTagsList ? 'granted' : 'not granted'}`,
    `protected domains: ${Array.isArray(config?.allowlist) ? config.allowlist.length : '?'}`,
    '',
    `rules (${rules.length}):`,
    ...rules.flatMap((r) => describeRule(r, runState, { includeValues })),
    '',
    `log (last ${entries?.length ?? 0} entries, oldest first):`,
    ...(entries ?? []).map(formatEntry),
  ];
  return `${lines.join('\n')}\n`;
}

/** `ffs-diagnostics-YYYY-MM-DD-HHMM.txt` in local time, like exportFilename(). */
export function diagnosticsFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `ffs-diagnostics-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.txt`;
}
