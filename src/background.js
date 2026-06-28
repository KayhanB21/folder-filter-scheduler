/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { evaluateRule, FIELDS } from './matcher.js';

/**
 * Background engine.
 *
 * Why a self-contained rule engine instead of re-running Thunderbird's built-in
 * filters? Because the WebExtension/MailExtension API exposes no hook to invoke
 * the legacy message-filter engine on demand against an arbitrary folder. So we
 * reimplement the matching (see matcher.js) and the actions here, and drive them
 * from the `alarms` API to get the periodic-on-any-folder behaviour that stock
 * Thunderbird only offers for the Inbox.
 */

const ALARM_NAME = 'folder-filter-scheduler.tick';
const DEFAULT_INTERVAL_MINUTES = 10;

const log = (...args) => console.log('[FolderFilterScheduler]', ...args);
const warn = (...args) => console.warn('[FolderFilterScheduler]', ...args);

/** @returns {Promise<{intervalMinutes:number, rules:Array}>} */
async function loadConfig() {
  const { config } = await messenger.storage.local.get({ config: null });
  return {
    intervalMinutes: config?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    rules: Array.isArray(config?.rules) ? config.rules : [],
  };
}

async function ensureAlarm() {
  const { intervalMinutes } = await loadConfig();
  const minutes = Math.max(1, Number(intervalMinutes) || DEFAULT_INTERVAL_MINUTES);
  await messenger.alarms.clear(ALARM_NAME);
  messenger.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
  log(`scheduled every ${minutes} min`);
}

/**
 * Build the normalized `{ fields }` object matcher.js expects from a message.
 * Header fields come from getFull(); we also seed the common addressing fields
 * from the lightweight MessageHeader so a rule still works if a header is sparse.
 */
async function normalize(messageHeader) {
  const fields = {};
  const push = (name, value) => {
    if (value == null || value === '') return;
    const key = name.toLowerCase();
    (fields[key] ??= []).push(String(value));
  };

  try {
    const full = await messenger.messages.getFull(messageHeader.id);
    const headers = full?.headers ?? {};
    for (const [name, values] of Object.entries(headers)) {
      for (const v of values) push(name, v);
    }
  } catch (e) {
    warn('getFull failed', messageHeader.id, e);
  }

  // Fallbacks from the indexed header in case getFull omitted something.
  if (!fields.from && messageHeader.author) push('from', messageHeader.author);
  if (!fields.subject && messageHeader.subject) push('subject', messageHeader.subject);
  for (const r of messageHeader.recipients ?? []) push('to', r);

  return { fields, _header: messageHeader };
}

/** Iterate every message in a folder, transparently following pagination. */
async function* messagesInFolder(folderId) {
  let page = await messenger.messages.query({ folderId, autoPaginationTimeout: 0 });
  while (page) {
    for (const m of page.messages) yield m;
    if (!page.id) break;
    page = await messenger.messages.continueList(page.id);
  }
}

async function applyAction(ids, action) {
  if (ids.length === 0) return;
  switch (action?.type) {
    case 'move':
      await messenger.messages.move(ids, action.folderId);
      break;
    case 'copy':
      await messenger.messages.copy(ids, action.folderId);
      break;
    case 'trash': // move to Trash (recoverable)
      await messenger.messages.delete(ids, false);
      break;
    case 'deletePermanently':
      await messenger.messages.delete(ids, true);
      break;
    case 'markRead':
      await Promise.all(ids.map((id) => messenger.messages.update(id, { read: true })));
      break;
    case 'markFlagged':
      await Promise.all(ids.map((id) => messenger.messages.update(id, { flagged: true })));
      break;
    case 'markJunk':
      await Promise.all(ids.map((id) => messenger.messages.update(id, { junk: true })));
      break;
    default:
      warn('unknown action type', action?.type);
  }
}

/** Run one rule across all its source folders. Returns count of affected messages. */
async function runRule(rule) {
  if (rule.enabled === false) return 0;
  let affected = 0;

  for (const folderId of rule.folderIds ?? []) {
    const matchedIds = [];
    try {
      for await (const header of messagesInFolder(folderId)) {
        const message = await normalize(header);
        if (evaluateRule(message, rule)) matchedIds.push(header.id);
      }
    } catch (e) {
      warn(`scan failed for folder ${folderId} in rule "${rule.name}"`, e);
      continue;
    }
    try {
      await applyAction(matchedIds, rule.action);
      affected += matchedIds.length;
    } catch (e) {
      warn(`action failed for rule "${rule.name}"`, e);
    }
  }
  return affected;
}

/** Run every enabled rule. Exposed to the options page via runtime messaging. */
async function runAllRules(reason = 'manual') {
  const { rules } = await loadConfig();
  let total = 0;
  for (const rule of rules) {
    const n = await runRule(rule);
    if (n) log(`rule "${rule.name}" affected ${n} message(s)`);
    total += n;
  }
  log(`run (${reason}) complete — ${total} message(s) affected across ${rules.length} rule(s)`);
  return total;
}

messenger.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) runAllRules('scheduled');
});

messenger.runtime.onMessage.addListener((msg) => {
  if (msg?.command === 'runNow') {
    return runAllRules('manual').then((affected) => ({ ok: true, affected }));
  }
  if (msg?.command === 'reschedule') {
    return ensureAlarm().then(() => ({ ok: true }));
  }
  return undefined;
});

messenger.runtime.onInstalled.addListener(ensureAlarm);
messenger.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

// Re-exported so the options UI can render the supported field list from one source of truth.
export { FIELDS };
