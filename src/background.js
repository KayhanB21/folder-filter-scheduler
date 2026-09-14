/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { evaluateRule, requiresFullMessage, addressBookIdsOf, FIELDS, DOMAIN_IN_LIST } from './matcher.js';
import { ALL_ADDRESS_BOOKS, addressSetFromVCards } from './contacts.js';
import { LOG_CAP, appendEntries, buildReport, makeEntry } from './diagnostics.js';
import { actionsOf, runActions } from './actions.js';
import { planScan, queryBoundsFor, stampScan } from './scan.js';
import { ADVANCED_DEFAULTS, sanitizeAdvanced } from './settings.js';
import { createRunner } from './runner.js';
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
 */

const ALARM_NAME = 'folder-filter-scheduler.tick';
const MENU_ID = 'folder-filter-scheduler.harvest-domains';
const DEFAULT_INTERVAL_MINUTES = 10;

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

async function applySettings() {
  const { intervalMinutes, advanced } = await loadConfig();
  advancedCache = advanced;
  const minutes = Math.max(1, Number(intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
  await messenger.alarms.clear(ALARM_NAME);
  messenger.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  log(
    `scheduled every ${minutes} min; new-mail trigger ` +
      (advanced.runOnNewMail ? `on (${advanced.newMailDelaySeconds}s)` : 'off'),
  );
}

/** Read a message's headers without paying for MIME parsing (TB 147+). */
async function readHeaders(messageId) {
  const raw = messenger.messages.getHeaders
    ? await messenger.messages.getHeaders(messageId)
    : await messenger.messages.getFull(messageId);
  return raw?.headers ?? raw ?? {};
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
async function normalize(messageHeader, fetchFull) {
  const fields = {};
  const push = (name, value) => {
    if (value == null || value === '') return;
    const key = name.toLowerCase();
    (fields[key] ??= []).push(String(value));
  };

  if (fetchFull) {
    try {
      const headers = await readHeaders(messageHeader.id);
      for (const [name, values] of Object.entries(headers)) {
        for (const v of values ?? []) push(name, v);
      }
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

  // The indexed Date, for age conditions. Free, no fetch.
  return { fields, date: messageHeader.date, _header: messageHeader };
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

/** Run one rule across all its source folders. Returns count of affected messages. */
async function runRule(rule, runState, manual, addressBooks, settings) {
  if (rule.enabled === false) return 0;
  const fetchFull = requiresFullMessage(rule);
  // Stamped before the scan so messages arriving mid-scan are not skipped next time.
  const startedAt = new Date();
  const plan = planScan(runState[rule.id], { manual, now: startedAt, settings });
  const { kind } = plan;
  const bounds = queryBoundsFor(rule, plan, startedAt);
  let affected = 0;
  let scanned = 0;
  let matched = 0;
  let scanFailed = false;

  for (const folderId of rule.folderIds ?? []) {
    const matchedIds = [];
    try {
      for await (const header of messagesInFolder(folderId, bounds)) {
        scanned += 1;
        const message = await normalize(header, fetchFull);
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

  // Only advance the watermark on a clean pass, so a transient failure does not
  // permanently skip the messages it could not read.
  if (!scanFailed && rule.id) {
    runState[rule.id] = stampScan(runState[rule.id], kind, startedAt);
  }
  const range = [
    bounds.fromDate ? `from ${bounds.fromDate.toISOString()}` : 'from start',
    bounds.toDate ? `to ${bounds.toDate.toISOString()}` : null,
  ].filter(Boolean).join(' ');
  log(
    `rule "${rule.name}": ${kind} scan (${range}), ${scanned} scanned, ${matched} matched, ` +
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
 */
async function runAllRules(reason = 'manual', { folderIds = null } = {}) {
  const { rules, advanced } = await loadConfig();
  const runState = await loadRunState();
  const manual = reason === 'manual';
  const selected = folderIds
    ? rules.filter((rule) => (rule.folderIds ?? []).some((id) => folderIds.has(id)))
    : rules;

  // Mail landed somewhere no rule watches. Return before touching the run
  // state: stamping watermarks for a scan that never happened would be wrong,
  // and writing storage on every unrelated arrival is pure noise.
  if (folderIds && selected.length === 0) {
    log(`run (${reason}) skipped: no rule watches the ${folderIds.size} folder(s) involved`);
    await flushLog();
    return 0;
  }

  const addressBooks = await loadAddressBooks(selected);
  let total = 0;

  for (const rule of selected) {
    total += await runRule(rule, runState, manual, addressBooks, advanced);
  }

  await saveRunState(runState);
  log(
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
  const [{ config, runState, diagnostics }, alarm, browser, platform, addressBooks, messagesTagsList] =
    await Promise.all([
      messenger.storage.local.get({ config: null, runState: {}, diagnostics: [] }),
      messenger.alarms.get(ALARM_NAME).catch(() => null),
      messenger.runtime.getBrowserInfo?.().catch(() => null) ?? null,
      messenger.runtime.getPlatformInfo?.().catch(() => null) ?? null,
      hasAddressBookAccess(),
      hasPermission('messagesTagsList'),
    ]);
  return buildReport({
    version: messenger.runtime.getManifest().version,
    browser,
    platform,
    config,
    runState,
    alarm,
    permissions: { addressBooks, messagesTagsList },
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

  for await (const header of eachMessage(selectedMessages)) {
    scanned += 1;
    try {
      const headers = await readHeaders(header.id);
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
 * Menus are not persisted for MV3 event pages, so this runs on every wake.
 * removeAll() first keeps a re-registration from failing on a duplicate id.
 */
async function registerMenu() {
  try {
    await messenger.menus.removeAll();
    messenger.menus.create({
      id: MENU_ID,
      title: 'Add spam domains to Folder Filter Scheduler',
      contexts: ['message_list'],
    });
  } catch (e) {
    warn('menu registration failed', e);
  }
}

messenger.menus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;
  handleHarvest(info).catch((e) => warn('harvest failed', e));
});

messenger.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  runner.request('scheduled').catch((e) => warn('scheduled run failed', e));
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
    return runner.request('manual').then((affected) => ({ ok: true, affected }));
  }
  if (msg?.command === 'reschedule') {
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
messenger.runtime.onStartup.addListener(applySettings);
applySettings();
registerMenu();

// Re-exported so the options UI can render the supported field list from one source of truth.
export { FIELDS };
