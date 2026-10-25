/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { evaluateRule, requiresFullMessage, requiresRaw, addressBookIdsOf, FIELDS, DOMAIN_IN_LIST } from './matcher.js';
import { ALL_ADDRESS_BOOKS, addressSetFromVCards } from './contacts.js';
import { LOG_CAP, appendEntries, buildReport, makeEntry } from './diagnostics.js';
import { actionsOf, runActions } from './actions.js';
import { planScan, queryBoundsFor, stampScan } from './scan.js';
import { ADVANCED_DEFAULTS, AUTH_DOH_SERVERS, alarmNeedsReset, dohOrigin, sanitizeAdvanced, trustedServerList } from './settings.js';
import { createRunner } from './runner.js';
import { createHeaderReads } from './headers.js';
import { createAuthReads } from './auth/reads.js';
import { AUTH_CACHE_KEY } from './auth/cache.js';
import { OWN_BLOCKED, OWN_OFF, OWN_ON } from './auth/check.js';
import { dohQuery } from './auth/doh.js';
import { resolveRuleFolders } from './folders.js';
import { cronAlarmNeedsReset, missedRun, nextRun, scheduleOf } from './cron.js';
import { MENU_HARVEST, MENU_RUN_ALL, SHORT_NAME, displayName, menuItems, ruleIdFromMenuItem } from './menu.js';
import {
  DEFAULT_ALLOWLIST,
  addressesFromHeaderValue,
  harvestDomains,
  mergeDomainLists,
} from './domains.js';

/**
 * Background engine.
 *
 * Why a self-contained rule engine instead of re-running Thunderbird's built-in
 * filters? Because the WebExtension/MailExtension API exposes no hook to invoke
 * the legacy message-filter engine on demand against an arbitrary folder. So we
 * reimplement the matching (see matcher.js) and the actions here, and drive them
 * from the `alarms` API to get the periodic-on-any-folder behaviour that stock
 * Thunderbird only offers for the Inbox.
 *
 * Two triggers, not one. The alarm is the backstop: it covers mail that arrived
 * while Thunderbird was closed, rules that match on age, and the periodic
 * catch-up for mail whose Date header lags its arrival. On top of that,
 * `messages.onNewMailReceived` starts a run within seconds of mail landing, so
 * a rule does not have to wait out the interval. Both go through `runner`,
 * which keeps two runs from overlapping and corrupting the per-rule run state.
 *
 * A rule can opt out of both and carry its own cron schedule (see cron.js). It
 * then has an alarm of its own and runs only when that fires, or by hand.
 */

const ALARM_NAME = 'folder-filter-scheduler.tick';
/** One alarm per rule with its own schedule, named by the rule id. */
const CRON_ALARM_PREFIX = 'folder-filter-scheduler.rule.';
const DEFAULT_INTERVAL_MINUTES = 10;

/**
 * How long one header download may take, and how many may end with no headers
 * before the run stops downloading. The first download of a run can include
 * the IMAP login, so the limit is generous: a false timeout makes a working
 * rule skip mail, which is worse than a slow run. Thunderbird suspends an idle
 * event page after about 30 seconds, so the worst case of two waits, 14
 * seconds, leaves room to log the result and save the run. headers.js holds
 * the policy, including the second way to read that follows a timeout.
 */
const HEADER_TIMEOUT_MS = 7_000;
const HEADER_TIMEOUT_LIMIT = 2;

/**
 * The SPF, DKIM, and DMARC check downloads whole messages. One download may
 * take 7 seconds, like a header read, and all downloads of a run together 20
 * seconds, so the run ends well inside the 30-second limit of an idle event
 * page. Messages left over wait for the next run. See auth/reads.js.
 */
const RAW_TIMEOUT_MS = 7_000;
const RAW_BUDGET_MS = 20_000;
/** A one-shot alarm for the quick retries after a DNS error. See auth/cache.js. */
const AUTH_RETRY_ALARM = 'folder-filter-scheduler.auth-retry';

/**
 * Headers the right-click harvest reads, most trustworthy first.
 *
 * Reply-To is harder to forge on bulk mail, but most spam carries no Reply-To at
 * all, so From is harvested too. They are kept apart all the way to the
 * confirmation dialog: a From domain can be forged to impersonate a brand, so it
 * is presented in its own group for the user to vet rather than mixed in.
 */
const HARVEST_FIELDS = ['reply-to', 'from'];
const HARVEST_RULE_NAME = 'Spam domains';

/**
 * Logging goes to the console and to a persistent ring buffer, so a user can
 * send a diagnostics report without opening the developer tools. Entries are
 * batched and written on a short debounce, and flushed at the end of every run.
 * Callers must never log addresses, domains, or subjects: the log ends up in
 * shared reports. Rule names, counts, ids, and timestamps are fine.
 */
const pendingLog = [];
let flushTimer = null;
let flushChain = Promise.resolve();

function record(level, args) {
  pendingLog.push(makeEntry(level, args));
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushLog, 2000);
}

/** Serialised so two flushes can never interleave their read and write. */
function flushLog() {
  clearTimeout(flushTimer);
  flushChain = flushChain
    .then(async () => {
      if (pendingLog.length === 0) return;
      const batch = pendingLog.splice(0);
      const { diagnostics } = await messenger.storage.local.get({ diagnostics: [] });
      await messenger.storage.local.set({ diagnostics: appendEntries(diagnostics, batch, LOG_CAP) });
    })
    .catch((e) => console.warn('[FolderFilterScheduler] could not persist log', e));
  return flushChain;
}

const log = (...args) => {
  console.log('[FolderFilterScheduler]', ...args);
  record('info', args);
};
const warn = (...args) => {
  console.warn('[FolderFilterScheduler]', ...args);
  record('warn', args);
};

/**
 * A routine line about a run on a rule's own schedule. It reaches the console
 * always, and the diagnostics log only when `quiet` is false. A rule on a
 * 1-minute schedule would otherwise fill the log within hours and push out
 * the entries a report is for. Runs that change mail or fail are never quiet.
 */
const logUnless = (quiet, ...args) => {
  if (quiet) console.log('[FolderFilterScheduler]', ...args);
  else log(...args);
};

const newId = () => globalThis.crypto.randomUUID();

/**
 * Load config, bringing older rules up to the current shape.
 *
 * Rules need an identity that survives a rename because per-rule run state is
 * keyed by it. The options page rebuilds rules from the DOM on every save, so
 * the id is round-tripped through a hidden field there.
 *
 * Rules written before 0.3.2 carry a single `action`; they are rewritten to the
 * `actions` list once, here, so nothing downstream has to know about both.
 */
async function loadConfig() {
  const { config } = await messenger.storage.local.get({ config: null });
  const rules = Array.isArray(config?.rules) ? config.rules : [];

  let migrated = false;
  for (const rule of rules) {
    if (!rule.id) {
      rule.id = newId();
      migrated = true;
    }
    if (!Array.isArray(rule.actions)) {
      rule.actions = actionsOf(rule);
      delete rule.action;
      migrated = true;
    }
  }

  const loaded = {
    intervalMinutes: config?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    advanced: sanitizeAdvanced(config?.advanced).settings,
    rules,
    allowlist: Array.isArray(config?.allowlist) ? config.allowlist : [...DEFAULT_ALLOWLIST],
    skipHarvestConfirm: config?.skipHarvestConfirm === true,
    harvestRuleId: config?.harvestRuleId ?? null,
  };

  if (migrated) {
    await messenger.storage.local.set({ config: { ...config, ...loaded } });
    log(`assigned ids to ${rules.length} rule(s)`);
  }
  return loaded;
}

async function saveConfig(config) {
  const { config: stored } = await messenger.storage.local.get({ config: null });
  await messenger.storage.local.set({ config: { ...stored, ...config } });
}

/**
 * Per-rule run state lives under its own storage key, NOT inside `config`.
 * The options page overwrites `config` wholesale on save, which would otherwise
 * discard every rule's last-run timestamp each time a user pressed Save.
 */
async function loadRunState() {
  const { runState } = await messenger.storage.local.get({ runState: {} });
  return runState && typeof runState === 'object' ? runState : {};
}

async function saveRunState(runState) {
  await messenger.storage.local.set({ runState });
}

/**
 * The advanced settings, cached for the new-mail listener.
 *
 * That listener fires once per arriving message and must decide in microseconds
 * whether to arm its timer, so it cannot await storage. `applySettings` runs on
 * install, on startup, on wake, and whenever the options page saves, which is
 * every occasion the values can change.
 */
let advancedCache = { ...ADVANCED_DEFAULTS };

/**
 * Rules with their own schedule whose time has come. The alarm handler adds an
 * id and asks the runner for a run; the run takes the whole set. A set, because
 * two rules can be due in the same minute and one run serves both.
 */
const dueCronRules = new Set();

/**
 * Give every rule with its own schedule one alarm for its next time, and drop
 * the alarms of rules that no longer have one. An alarm fires once, so the
 * handler sets the next one after each run.
 */
async function syncCronAlarms(rules, advanced) {
  const wanted = new Map();
  for (const rule of rules) {
    const cron = scheduleOf(rule);
    if (cron && rule.id && rule.enabled !== false) wanted.set(CRON_ALARM_PREFIX + rule.id, { cron, rule });
  }

  const existing = new Map((await messenger.alarms.getAll()).map((a) => [a.name, a]));
  for (const name of existing.keys()) {
    if (name.startsWith(CRON_ALARM_PREFIX) && !wanted.has(name)) await messenger.alarms.clear(name);
  }

  const now = Date.now();
  for (const [name, { cron, rule }] of wanted) {
    const next = nextRun(cron, new Date(now));
    if (!next) {
      await messenger.alarms.clear(name);
      continue;
    }
    if (!cronAlarmNeedsReset(existing.get(name), next.getTime(), now)) continue;
    messenger.alarms.create(name, { when: next.getTime() });
    logUnless(
      !advanced.logScheduleRuns,
      `rule "${rule.name}": own schedule (${cron.expression}), next run ${next.toISOString()}`,
    );
  }
}

async function applySettings() {
  const { intervalMinutes, advanced, rules } = await loadConfig();
  advancedCache = advanced;
  await syncCronAlarms(rules, advanced).catch((e) => warn('could not set the rule schedules', e));
  const minutes = Math.max(1, Number(intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
  // Keep a running alarm: this also runs on every wake, and re-creating the
  // alarm would restart its countdown each time new mail arrives.
  const alarm = await messenger.alarms.get(ALARM_NAME).catch(() => null);
  if (!alarmNeedsReset(alarm, minutes)) return;
  await messenger.alarms.clear(ALARM_NAME);
  messenger.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  log(
    `scheduled every ${minutes} min; new-mail trigger ` +
      (advanced.runOnNewMail ? `on (${advanced.newMailDelaySeconds}s)` : 'off'),
  );
}

/**
 * Accounts where `getHeaders` gave no answer, kept in session storage. So a
 * later run reads whole messages on them at once and skips the 7-second wait,
 * also after the event page was suspended. Session storage empties when
 * Thunderbird closes, so each start tries `getHeaders` again, in case the
 * hang is gone.
 */
const FULL_READ_ACCOUNTS_KEY = 'headerFullReadAccounts';

/**
 * The header reads of one run, or of one right-click harvest. `getHeaders`
 * skips MIME parsing (TB 147+); `getFull` is the fallback for an account where
 * it never answers.
 */
async function newHeaderReads() {
  const session = messenger.storage.session;
  const stored = await session?.get(FULL_READ_ACCOUNTS_KEY).catch(() => null);
  const known = new Set(stored?.[FULL_READ_ACCOUNTS_KEY] ?? []);
  return createHeaderReads({
    viaFull: known,
    onSwitch: (accountId) => {
      known.add(accountId);
      return session
        ?.set({ [FULL_READ_ACCOUNTS_KEY]: [...known] })
        .catch((e) => warn('could not remember the account for whole-message reads', e));
    },
    getHeaders: messenger.messages.getHeaders && ((id) => messenger.messages.getHeaders(id)),
    getFull: (id) => messenger.messages.getFull(id),
    timeoutMs: HEADER_TIMEOUT_MS,
    limit: HEADER_TIMEOUT_LIMIT,
    // Saved at once: the run might be suspended before the usual delay.
    onTimeout: (message) => {
      warn(message);
      return flushLog();
    },
  });
}

// --- SPF, DKIM, and DMARC ----------------------------------------------------

async function hasOrigin(origin) {
  try {
    return await messenger.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/**
 * Whether the own DKIM check runs. It needs the host permission for the DNS
 * server, which the options page asks for. Without it the check is blocked,
 * and DKIM and DMARC conditions never match until you grant it or turn the
 * own check off.
 */
async function ownCheckState(advanced) {
  if (!advanced.authOwnCheck) return OWN_OFF;
  const origin = dohOrigin(advanced.authDohServer);
  return origin && (await hasOrigin(origin)) ? OWN_ON : OWN_BLOCKED;
}

/**
 * A whole message as a binary string, one character per byte, which is what
 * the DKIM code reads. Thunderbird returns a File unless asked for a string,
 * so a File is converted too.
 */
async function rawMessage(id) {
  const raw = await messenger.messages.getRaw(id, { data_format: 'BinaryString' });
  if (typeof raw === 'string') return raw;
  const bytes = new Uint8Array(await raw.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return text;
}

/** The SPF, DKIM, and DMARC reads of one run. See auth/reads.js. */
async function newAuthReads(advanced) {
  const ownState = await ownCheckState(advanced);
  const stored = await messenger.storage.local.get({ [AUTH_CACHE_KEY]: {} }).catch(() => ({}));
  if (ownState === OWN_BLOCKED) {
    warn('DNS server access not granted; DKIM and DMARC conditions will not match');
  }
  return createAuthReads({
    getRaw: (id) => rawMessage(id),
    queryFunction: dohQuery(AUTH_DOH_SERVERS[advanced.authDohServer]),
    ownState,
    prefer: advanced.authPrefer,
    trustedServers: trustedServerList(advanced.authTrustedServers),
    cache: stored?.[AUTH_CACHE_KEY] ?? {},
    timeoutMs: RAW_TIMEOUT_MS,
    budgetMs: RAW_BUDGET_MS,
  });
}

/** Save the cache, set the next quick retry, and log what the run did. */
async function finishAuthReads(authReads, quiet) {
  const { cache, retryDelayMs } = authReads.finish();
  if (cache) {
    await messenger.storage.local.set({ [AUTH_CACHE_KEY]: cache })
      .catch((e) => warn('could not save the auth check cache', e));
  }
  if (retryDelayMs !== null) messenger.alarms.create(AUTH_RETRY_ALARM, { when: Date.now() + retryDelayMs });
  const c = authReads.counts;
  logUnless(
    quiet && c.checked === 0 && c.unchecked === 0,
    `auth checks (own check ${authReads.ownState}): ${c.checked} checked, ${c.cached} from cache, ` +
      `${c.failed} failed for now, ${c.deferred} left for the next run, ` +
      `${c.unchecked} unchecked after retries, ${c.disagree} disagreed with the provider`,
  );
  // Counts only: the log never names a sender or a domain.
  const tallies = Object.entries(c.results).map(([method, r]) =>
    `${method} ${r.pass} pass, ${r.notPass} not pass, ${r.unknown} unknown`);
  logUnless(quiet && c.checked === 0 && c.unchecked === 0, `auth results: ${tallies.join('; ')}`);
}

/**
 * Build the normalized `{ fields }` object matcher.js expects from a message.
 *
 * When `fetchFull` is false (the rule only needs from/to/cc/subject) we read
 * everything from the lightweight MessageHeader — no network, works offline,
 * irrespective of whether the folder is stored locally. Only when a rule needs
 * a non-indexed header (reply-to, list-id, …) do we read the headers, which
 * fetches from the server on demand on a non-offline IMAP folder.
 */
async function normalize(messageHeader, fetchFull, headerReads, authReads) {
  const fields = {};
  const push = (name, value) => {
    if (value == null || value === '') return;
    const key = name.toLowerCase();
    (fields[key] ??= []).push(String(value));
  };

  // A message whose headers cannot be read is left out of the run. Matching it
  // on the indexed fields alone is unsafe: "Reply-To does not contain X" is
  // true for a missing header, and a rule that deletes would then act on mail
  // it never read.
  let headersRead = false;
  if (fetchFull) {
    try {
      const headers = await headerReads.read(messageHeader.id, messageHeader.folder?.accountId);
      if (!headers) return null;
      for (const [name, values] of Object.entries(headers)) {
        for (const v of values ?? []) push(name, v);
      }
      headersRead = true;
    } catch (e) {
      warn('header read failed', messageHeader.id, e);
    }
  }

  // Cheap fields from the indexed header — the only source when fetchFull is
  // false, and a fallback for anything the header read happened to omit.
  if (!fields.from && messageHeader.author) push('from', messageHeader.author);
  if (!fields.subject && messageHeader.subject) push('subject', messageHeader.subject);
  if (!fields.to) for (const r of messageHeader.recipients ?? []) push('to', r);
  if (!fields.cc) for (const c of messageHeader.ccList ?? []) push('cc', c);

  // SPF, DKIM, and DMARC, only for a rule that checks them. A pending result
  // is unknown for now, so its conditions don't match, and the run keeps the
  // watermark so the message is checked again.
  let auth;
  let authPending = false;
  if (authReads) ({ auth, pending: authPending } = await authReads.read(messageHeader));

  // The indexed Date, state, and tags, for the conditions that are not about a
  // header. Free, no fetch.
  return {
    fields,
    date: messageHeader.date,
    state: { read: messageHeader.read, star: messageHeader.flagged, junk: messageHeader.junk },
    tags: messageHeader.tags,
    // A priority condition needs to know the headers are really there.
    headersRead,
    auth,
    authPending,
    _header: messageHeader,
  };
}

/** Walk any paginated MessageList (a query result or a menu selection). */
async function* eachMessage(list) {
  let page = list;
  while (page) {
    for (const m of page.messages ?? []) yield m;
    if (!page.id) break;
    page = await messenger.messages.continueList(page.id);
  }
}

/** Iterate a folder, optionally bounded by Date on either side. */
async function* messagesInFolder(folderId, { fromDate, toDate } = {}) {
  const query = { folderId, autoPaginationTimeout: 0 };
  if (fromDate instanceof Date) query.fromDate = fromDate;
  if (toDate instanceof Date) query.toDate = toDate;
  yield* eachMessage(await messenger.messages.query(query));
}

/**
 * Every folder, for rules that include subfolders. Read once per run, so a
 * subfolder created since the last run is picked up without editing the rule.
 * Empty when no selected rule needs it, or if the query fails: each rule then
 * falls back to the folders it names.
 */
async function loadAllFolders(rules) {
  if (!rules.some((r) => r.includeSubfolders === true) || !messenger.folders?.query) return [];
  try {
    return await messenger.folders.query({});
  } catch (e) {
    warn('folder list failed, subfolders skipped this run', e);
    return [];
  }
}

/** Run one rule across all its source folders. Returns count of affected messages. */
async function runRule(rule, folderIds, runState, manual, addressBooks, settings, headerReads, authReads, quiet) {
  if (rule.enabled === false) return 0;
  const fetchFull = requiresFullMessage(rule);
  const ruleAuthReads = requiresRaw(rule) ? authReads : null;
  // Stamped before the scan so messages arriving mid-scan are not skipped next time.
  const startedAt = new Date();
  const plan = planScan(runState[rule.id], { manual, now: startedAt, settings });
  const { kind } = plan;
  const bounds = queryBoundsFor(rule, plan, startedAt);
  let affected = 0;
  let scanned = 0;
  let matched = 0;
  let scanFailed = false;
  let authPending = 0;
  const skippedBefore = headerReads.skipped;

  for (const folderId of folderIds) {
    const matchedIds = [];
    try {
      for await (const header of messagesInFolder(folderId, bounds)) {
        scanned += 1;
        const message = await normalize(header, fetchFull, headerReads, ruleAuthReads);
        if (!message) continue;
        if (message.authPending) authPending += 1;
        if (evaluateRule(message, rule, { now: startedAt, addressBooks })) matchedIds.push(header.id);
      }
    } catch (e) {
      warn(`scan failed for folder ${folderId} in rule "${rule.name}"`, e);
      scanFailed = true;
      continue;
    }
    try {
      matched += matchedIds.length;
      await runActions(messenger, matchedIds, actionsOf(rule));
      affected += matchedIds.length;
    } catch (e) {
      warn(`action failed for rule "${rule.name}"`, e);
      scanFailed = true;
    }
  }

  // A message whose headers did not arrive was left out, so the pass is not
  // clean and the next run reads it again.
  const skipped = headerReads.skipped - skippedBefore;
  if (skipped > 0) scanFailed = true;
  // The same for a message whose SPF, DKIM, and DMARC check waits for a retry.
  // This is not an error, so the log line doesn't say WITH ERRORS.
  const holdWatermark = scanFailed || authPending > 0;

  // Only advance the watermark on a clean pass, so a transient failure does not
  // permanently skip the messages it could not read.
  if (!holdWatermark && rule.id) {
    runState[rule.id] = stampScan(runState[rule.id], kind, startedAt);
  }
  const range = [
    bounds.fromDate ? `from ${bounds.fromDate.toISOString()}` : 'from start',
    bounds.toDate ? `to ${bounds.toDate.toISOString()}` : null,
  ].filter(Boolean).join(' ');
  logUnless(
    quiet && affected === 0 && !scanFailed,
    `rule "${rule.name}": ${kind} scan (${range}), ${scanned} scanned, ` +
      `${skipped > 0 ? `${skipped} skipped (headers unread), ` : ''}` +
      `${authPending > 0 ? `${authPending} waiting for an auth check, ` : ''}${matched} matched, ` +
      `${affected} actioned, ${Date.now() - startedAt.getTime()} ms${scanFailed ? ', WITH ERRORS' : ''}`,
  );
  return affected;
}

/**
 * Run the enabled rules. Exposed to the options page via runtime messaging.
 *
 * `folderIds` narrows the run to the rules watching those folders, which is how
 * a new-mail trigger avoids re-querying every folder of every rule because one
 * message landed somewhere. A rule left out keeps its watermark, so the next
 * scheduled run still covers it.
 *
 * `ruleIds` narrows a manual run to the rules named, which is the Run button on
 * one rule: only those get the full scan. `background` is true when a scheduled
 * or new-mail trigger shares the run, and the other rules then get their usual
 * incremental pass. See runner.js.
 */
async function runAllRules(
  reason = 'manual',
  { folderIds = null, ruleIds = null, background = false } = {},
) {
  // Taken before the first await, so an alarm that fires during this run adds
  // to a fresh set and is served by the run queued behind this one.
  const due = new Set(dueCronRules);
  dueCronRules.clear();
  const { rules, advanced } = await loadConfig();
  const runState = await loadRunState();
  const manual = reason === 'manual';
  const isManual = (rule) => manual && (!ruleIds || ruleIds.has(rule.id));
  const allFolders = await loadAllFolders(rules);
  const scanned = new Map(rules.map((rule) => [rule, resolveRuleFolders(rule, allFolders)]));
  const selected = rules.filter((rule) => {
    if (isManual(rule)) return true;
    // A rule with its own schedule ignores the timer and new mail.
    if (scheduleOf(rule)) return due.has(rule.id);
    if (manual && !background) return false;
    // New mail in a subfolder counts for a rule that includes subfolders.
    return !folderIds || scanned.get(rule).some((id) => folderIds.has(id));
  });

  // Mail landed somewhere no rule watches, or the rule asked for is not saved.
  // Return before touching the run state: stamping watermarks for a scan that
  // never happened would be wrong, and writing storage on every unrelated
  // arrival is pure noise.
  if (selected.length === 0 && (folderIds || ruleIds)) {
    let why = 'the rule asked for is not saved';
    if (folderIds) {
      why = folderIds.size > 0
        ? `no rule watches the ${folderIds.size} folder(s) involved`
        : 'no rule is due';
    }
    logUnless(folderIds?.size === 0 && !advanced.logScheduleRuns, `run (${reason}) skipped: ${why}`);
    await flushLog();
    return 0;
  }

  // Routine lines about rules on their own schedule stay out of the log, see
  // `logUnless`. The whole run is quiet only when it holds nothing else.
  const quietRule = (rule) => !advanced.logScheduleRuns && due.has(rule.id) && !isManual(rule);
  const quietRun = selected.length > 0 && selected.every(quietRule);
  // Logged before the scan so a run that never finishes still leaves a trace.
  logUnless(quietRun, `run (${reason}) started: ${selected.length} of ${rules.length} rule(s)`);
  const addressBooks = await loadAddressBooks(selected);
  // Shared by every rule of the run: see HEADER_TIMEOUT_LIMIT.
  const headerReads = await newHeaderReads();
  // Shared too, so the download budget covers the whole run.
  const authReads = selected.some(requiresRaw) ? await newAuthReads(advanced) : null;
  let total = 0;

  for (const rule of selected) {
    total += await runRule(
      rule, scanned.get(rule), runState, isManual(rule), addressBooks, advanced, headerReads,
      authReads, quietRule(rule),
    );
  }

  await saveRunState(runState);
  if (authReads) await finishAuthReads(authReads, quietRun);
  logUnless(
    quietRun && total === 0,
    `run (${reason}) complete: ${total} message(s) affected across ` +
      `${selected.length} of ${rules.length} rule(s)`,
  );
  await flushLog();
  return total;
}

/**
 * Every trigger goes through here. See runner.js: it serialises runs so the
 * alarm and a new-mail trigger cannot both read and write the run state, and
 * collapses a burst of triggers into a single follow-up run.
 */
const runner = createRunner(runAllRules);

// --- Address books -----------------------------------------------------------

async function hasPermission(name) {
  try {
    return await messenger.permissions.contains({ permissions: [name] });
  } catch {
    return false;
  }
}

const hasAddressBookAccess = () => hasPermission('addressBooks');

/**
 * Load every address book an enabled rule refers to, once per run, as Sets of
 * lowercased addresses. A book that cannot be read maps to null, which the
 * matcher treats as "never matches" in both polarities. For "all address
 * books" a single unreadable book makes the whole union null: a partial union
 * would make some contacts look like strangers to a "not in address book" rule.
 *
 * Remote (LDAP) books are skipped: they cannot be enumerated.
 */
async function loadAddressBooks(rules) {
  const books = new Map();
  const ids = new Set(rules.filter((r) => r.enabled !== false).flatMap(addressBookIdsOf));
  if (ids.size === 0) return books;

  if (!(await hasAddressBookAccess()) || !messenger.addressBooks?.list) {
    warn(`address book access not granted; ${ids.size} address book condition(s) will not match`);
    return books;
  }

  let local;
  try {
    local = (await messenger.addressBooks.list(false)).filter((b) => !b.remote);
  } catch (e) {
    warn('could not list address books', e);
    return books;
  }

  const cache = new Map();
  const read = async (id) => {
    if (!cache.has(id)) {
      try {
        const contacts = await messenger.addressBooks.contacts.list(id);
        cache.set(id, addressSetFromVCards(contacts.map((c) => c.vCard)));
      } catch (e) {
        warn(`could not read address book ${id}`, e);
        cache.set(id, null);
      }
    }
    return cache.get(id);
  };

  for (const id of ids) {
    if (id === ALL_ADDRESS_BOOKS) {
      const union = new Set();
      let failed = false;
      for (const book of local) {
        const set = await read(book.id);
        if (set === null) {
          failed = true;
          break;
        }
        for (const address of set) union.add(address);
      }
      books.set(id, failed ? null : union);
    } else if (!local.some((b) => b.id === id)) {
      warn(`address book ${id} not found; its conditions will not match`);
      books.set(id, null);
    } else {
      books.set(id, await read(id));
    }
  }

  log(
    'address books loaded: ' +
      [...books].map(([id, set]) => `${id}=${set ? `${set.size} address(es)` : 'unreadable'}`).join(', '),
  );
  return books;
}

// --- Diagnostics ---------------------------------------------------------------

async function diagnosticsReport(includeValues) {
  await flushLog();
  const advanced = (await loadConfig()).advanced;
  const [{ config, runState, diagnostics }, alarm, browser, platform, addressBooks, messagesTagsList, dnsServer] =
    await Promise.all([
      messenger.storage.local.get({ config: null, runState: {}, diagnostics: [] }),
      messenger.alarms.get(ALARM_NAME).catch(() => null),
      messenger.runtime.getBrowserInfo?.().catch(() => null) ?? null,
      messenger.runtime.getPlatformInfo?.().catch(() => null) ?? null,
      hasAddressBookAccess(),
      hasPermission('messagesTagsList'),
      hasOrigin(dohOrigin(advanced.authDohServer)),
    ]);
  return buildReport({
    version: messenger.runtime.getManifest().version,
    browser,
    platform,
    config,
    runState,
    alarm,
    permissions: { addressBooks, messagesTagsList, dnsServer },
    entries: diagnostics,
    includeValues: includeValues === true,
  });
}

// --- Right-click domain harvesting ----------------------------------------

/**
 * Find (or build) the rule the harvest merges into: a "match any" rule whose
 * single condition is a Reply-To domain list, moving matches to Trash.
 *
 * Trash rather than permanent delete is deliberate — a domain added by mistake
 * must stay recoverable.
 */
function harvestRuleFor(config) {
  const byId = config.harvestRuleId
    ? config.rules.find((r) => r.id === config.harvestRuleId)
    : null;
  const existing = byId ?? config.rules.find((r) => r.name === HARVEST_RULE_NAME);
  if (existing) return { rule: existing, created: false };

  return {
    created: true,
    rule: {
      id: newId(),
      name: HARVEST_RULE_NAME,
      enabled: true,
      match: 'any',
      folderIds: [],
      conditions: [
        { fields: [...HARVEST_FIELDS], operator: DOMAIN_IN_LIST, domains: [], negate: false },
      ],
      actions: [{ type: 'trash' }],
    },
  };
}

/** The domain-list condition inside a harvest rule, created if absent. */
function domainConditionOf(rule) {
  rule.conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  let condition = rule.conditions.find((c) => c.operator === DOMAIN_IN_LIST);
  if (!condition) {
    condition = { fields: [...HARVEST_FIELDS], operator: DOMAIN_IN_LIST, domains: [], negate: false };
    rule.conditions.push(condition);
  }
  condition.domains = Array.isArray(condition.domains) ? condition.domains : [];
  return condition;
}

/**
 * Merge domains into the harvest rule and persist. Also seeds the rule's source
 * folder with the folder the user harvested from, so a freshly created rule
 * actually does something without a trip to the options page.
 */
async function mergeHarvestedDomains(domains, sourceFolderId) {
  const config = await loadConfig();
  const { rule, created } = harvestRuleFor(config);
  const condition = domainConditionOf(rule);

  const { domains: merged, added } = mergeDomainLists(condition.domains, domains);
  condition.domains = merged;

  if (sourceFolderId && !(rule.folderIds ?? []).includes(sourceFolderId)) {
    rule.folderIds = [...(rule.folderIds ?? []), sourceFolderId];
  }

  const rules = created ? [...config.rules, rule] : config.rules;
  await saveConfig({ ...config, rules, harvestRuleId: rule.id });

  log(`harvest merged ${added.length} new domain(s); rule now holds ${merged.length}`);
  if (created) registerMenu();
  return { added, total: merged.length, ruleName: rule.name, created };
}

/** Hand a payload to the confirmation popup without putting it in the URL. */
async function stashPayload(payload) {
  const token = newId();
  const area = messenger.storage.session ?? messenger.storage.local;
  await area.set({ [`harvest:${token}`]: payload });
  return token;
}

async function takePayload(token) {
  const area = messenger.storage.session ?? messenger.storage.local;
  const key = `harvest:${token}`;
  const stored = await area.get({ [key]: null });
  await area.remove(key);
  return stored?.[key] ?? null;
}

/** Collect addresses per harvest header across every selected message. */
async function addressesFromSelection(selectedMessages) {
  const byField = Object.fromEntries(HARVEST_FIELDS.map((f) => [f, []]));
  let scanned = 0;
  let unreadable = 0;
  const headerReads = await newHeaderReads();

  for await (const header of eachMessage(selectedMessages)) {
    scanned += 1;
    try {
      const headers = await headerReads.read(header.id, header.folder?.accountId);
      if (!headers) {
        unreadable += 1;
        continue;
      }
      for (const field of HARVEST_FIELDS) {
        const found = (headers[field] ?? []).flatMap((v) => addressesFromHeaderValue(v));
        // Per message, not per batch: the indexed author stands in when this
        // message carries no From header of its own.
        if (found.length === 0 && field === 'from' && header.author) {
          found.push(...addressesFromHeaderValue(header.author));
        }
        byField[field].push(...found);
      }
    } catch (e) {
      warn('could not read headers for message', header.id, e);
      unreadable += 1;
    }
  }
  return { byField, scanned, unreadable };
}

async function handleHarvest(info) {
  const config = await loadConfig();
  const { byField, scanned, unreadable } = await addressesFromSelection(info.selectedMessages);

  // One group per header, in trust order. A domain already offered by a more
  // trustworthy header is not repeated in a later group.
  const groups = [];
  const alreadyOffered = new Set();
  for (const field of HARVEST_FIELDS) {
    const result = harvestDomains(byField[field], config.allowlist);
    const accepted = result.accepted.filter((d) => !alreadyOffered.has(d));
    for (const d of accepted) alreadyOffered.add(d);
    groups.push({ field, ...result, accepted });
  }

  const total = groups.reduce((n, g) => n + g.accepted.length, 0);
  log(`harvest scanned ${scanned} message(s), found ${total} candidate domain(s)`);
  flushLog();

  const payload = {
    groups,
    scanned,
    unreadable,
    folderId: info.displayedFolder?.id ?? null,
    ruleName: HARVEST_RULE_NAME,
  };

  if (config.skipHarvestConfirm && total > 0) {
    await mergeHarvestedDomains(groups.flatMap((g) => g.accepted), payload.folderId);
    return;
  }

  const token = await stashPayload(payload);
  await messenger.windows.create({
    url: `confirm/confirm.html?token=${encodeURIComponent(token)}`,
    type: 'popup',
    width: 560,
    height: 640,
  });
}

/**
 * Build the right-click menu. Menus are not persisted for MV3 event pages, so
 * this runs on every wake, and again when the saved rules change, because
 * "Run a rule" lists them. removeAll() first keeps a re-registration from
 * failing on a duplicate id. The builds are chained: two at once would
 * interleave their removeAll() and create() calls. With the menu turned off
 * under Advanced, removeAll() is the whole job.
 *
 * The toolbar button takes its label here too, because the same setting names
 * both. A null label hands the button back to the title in the manifest.
 */
let menuBuild = Promise.resolve();
function registerMenu() {
  menuBuild = menuBuild.then(async () => {
    try {
      const { rules, advanced } = await loadConfig();
      await messenger.action?.setLabel?.({ label: advanced.shortName ? SHORT_NAME : null });
      await messenger.menus.removeAll();
      if (!advanced.showMenu) return;
      const title = displayName(advanced.shortName);
      for (const item of menuItems(rules, undefined, title)) messenger.menus.create(item);
    } catch (e) {
      warn('menu registration failed', e);
    }
  });
  return menuBuild;
}

messenger.menus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_HARVEST) {
    handleHarvest(info).catch((e) => warn('harvest failed', e));
    return;
  }
  const ruleId = ruleIdFromMenuItem(info.menuItemId);
  if (info.menuItemId !== MENU_RUN_ALL && ruleId === null) return;
  const scope = ruleId === null ? {} : { ruleIds: new Set([ruleId]) };
  runner.request('manual', scope).catch((e) => warn('run from the menu failed', e));
});

/**
 * Ask for a run of the rules in `dueCronRules`. The empty folder set keeps the
 * run to those rules: it matches no rule on the default timer, and merged into
 * a queued run it widens nothing.
 */
const requestCronRun = () => runner.request('cron', { folderIds: new Set() });

/** A rule's own alarm fired: run the rule, and set the alarm for its next time. */
async function handleCronAlarm(alarm) {
  const ruleId = alarm.name.slice(CRON_ALARM_PREFIX.length);
  dueCronRules.add(ruleId);
  const run = requestCronRun();

  const { rules } = await loadConfig();
  const rule = rules.find((r) => r.id === ruleId);
  const cron = rule?.enabled === false ? null : scheduleOf(rule);
  // From the scheduled time when that is later, so an alarm that fires a
  // moment early cannot pick the same minute again.
  const from = new Date(Math.max(Date.now(), alarm.scheduledTime ?? 0));
  const next = cron ? nextRun(cron, from) : null;
  if (next) messenger.alarms.create(alarm.name, { when: next.getTime() });
  await run;
}

/**
 * Thunderbird was closed when a rule's time came. Run those rules once at
 * startup, as the default timer does for the mail it missed.
 */
async function runMissedCronRules() {
  const { rules } = await loadConfig();
  const runState = await loadRunState();
  const now = new Date();
  let missed = 0;
  for (const rule of rules) {
    const cron = rule.enabled === false ? null : scheduleOf(rule);
    if (!cron || !missedRun(cron, runState[rule.id]?.lastRunAt, now)) continue;
    dueCronRules.add(rule.id);
    missed += 1;
  }
  if (missed === 0) return;
  log(`${missed} rule(s) missed their own schedule while Thunderbird was closed, running`);
  await requestCronRun();
}

messenger.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    runner.request('scheduled').catch((e) => warn('scheduled run failed', e));
  } else if (alarm.name.startsWith(CRON_ALARM_PREFIX)) {
    handleCronAlarm(alarm).catch((e) => warn('run on a rule schedule failed', e));
  } else if (alarm.name === AUTH_RETRY_ALARM) {
    runner.request('authRetry').catch((e) => warn('auth check retry failed', e));
  }
});

// --- New mail ----------------------------------------------------------------

/**
 * Arm and disarm, as the Thunderbird reviewer suggested.
 *
 * One sync fires this event once per message, so running on each would be
 * absurd. Every event pushes the timer out instead, and the run happens once
 * the arrivals stop. The folders seen meanwhile are collected so the run can
 * skip rules that watch none of them.
 *
 * The timer is a plain setTimeout because `alarms` cannot go below a minute.
 * That is safe only because the delay is capped at 15 seconds (see
 * settings.js): an event page is suspended after about 30 seconds idle, and
 * each arriving message resets that clock.
 */
let newMailTimer = null;
const newMailFolders = new Set();

function fireNewMailRun() {
  newMailTimer = null;
  const folderIds = new Set(newMailFolders);
  newMailFolders.clear();
  if (folderIds.size === 0) return;
  log(`new mail in ${folderIds.size} folder(s), running`);
  runner.request('newMail', { folderIds }).catch((e) => warn('new-mail run failed', e));
}

if (messenger.messages?.onNewMailReceived?.addListener) {
  // monitorAllFolders: the whole point of this add-on is the folders that are
  // not the Inbox, and without it the event covers only inbox-like folders.
  messenger.messages.onNewMailReceived.addListener((folder) => {
    if (!advancedCache.runOnNewMail) return;
    if (folder?.id) newMailFolders.add(folder.id);
    clearTimeout(newMailTimer);
    newMailTimer = setTimeout(fireNewMailRun, advancedCache.newMailDelaySeconds * 1000);
  }, true);
}

messenger.runtime.onMessage.addListener((msg) => {
  if (msg?.command === 'runNow') {
    // A rule id is the Run button on one rule; without it, every rule runs.
    const scope = typeof msg.ruleId === 'string' ? { ruleIds: new Set([msg.ruleId]) } : {};
    return runner.request('manual', scope).then((affected) => ({ ok: true, affected }));
  }
  if (msg?.command === 'reschedule') {
    // The options page sends this after a save, so the rules might be new,
    // or the menu turned on or off, or renamed.
    registerMenu();
    return applySettings().then(() => ({ ok: true }));
  }
  if (msg?.command === 'diagnostics') {
    return diagnosticsReport(msg.includeValues).then((report) => ({ ok: true, report }));
  }
  if (msg?.command === 'clearDiagnostics') {
    pendingLog.length = 0;
    return messenger.storage.local.set({ diagnostics: [] }).then(() => ({ ok: true }));
  }
  if (msg?.command === 'harvestPayload') {
    return takePayload(msg.token).then((payload) => ({ ok: true, payload }));
  }
  if (msg?.command === 'harvestConfirm') {
    return (async () => {
      if (msg.skipNextTime) await saveConfig({ skipHarvestConfirm: true });
      const merged = await mergeHarvestedDomains(msg.domains ?? [], msg.folderId ?? null);
      return { ok: true, ...merged };
    })();
  }
  return undefined;
});

messenger.runtime.onInstalled.addListener(applySettings);
messenger.runtime.onStartup.addListener(() => {
  applySettings();
  runMissedCronRules().catch((e) => warn('missed-schedule run failed', e));
});
applySettings();
registerMenu();

// Re-exported so the options UI can render the supported field list from one source of truth.
export { FIELDS };
