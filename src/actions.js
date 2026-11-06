/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single source of truth for actions.
 *
 * Both the background engine (which executes `apply`) and the options UI (which
 * reads `label` / `needsFolder` / `needsTag` / `hint` / `danger`) are driven by
 * this list, so adding a new action is a one-entry change: no edits to the
 * engine switch or the HTML <option> list. `apply` receives the injected
 * `messenger` API, the matched message ids, and the action config
 * (e.g. `{ type, folderId }`).
 *
 * A rule can carry several actions. `terminal` marks the ones that consume the
 * message (its id stops being valid at the source folder afterwards), which is
 * why ordering is derived rather than trusted: see `orderActions`.
 *
 * `label` and `hint` are getters that read the message catalog, so they are in
 * the user's language whenever the options page reads them.
 */

import { t } from './i18n.js';

/**
 * How many messages one move, copy, archive, or delete call hands Thunderbird.
 *
 * A single archive of about 2600 messages finished its work but never
 * answered, so the run waited and the rules after it never ran. Smaller calls,
 * one after another, also keep a second archive from starting while the first
 * is still busy: Thunderbird allows only one at a time.
 */
export const BATCH_SIZE = 200;

/**
 * Call `fn` on `ids` in groups of `BATCH_SIZE`, each after the one before.
 *
 * `onProgress(done, total)` follows each group, but only when there is more
 * than one: a log line per group then shows where a call that never answers
 * stopped, and a small action adds no lines at all.
 */
async function inBatches(ids, fn, onProgress) {
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await fn(ids.slice(i, i + BATCH_SIZE));
    if (ids.length > BATCH_SIZE) await onProgress?.(Math.min(i + BATCH_SIZE, ids.length), ids.length);
  }
}

/**
 * Add a tag without disturbing the ones already on the message.
 *
 * `messages.update` replaces the whole tag array, so each message is read back
 * first. Tags the user set by hand, or an earlier rule set, must survive.
 */
async function applyTag(messenger, ids, action) {
  await Promise.all(
    ids.map(async (id) => {
      const header = await messenger.messages.get(id);
      const tags = Array.isArray(header?.tags) ? header.tags : [];
      if (tags.includes(action.tagKey)) return;
      await messenger.messages.update(id, { tags: [...tags, action.tagKey] });
    }),
  );
}

export const ACTIONS = [
  {
    id: 'trash',
    get label() { return t('action_trash'); },
    needsFolder: false,
    terminal: true,
    get hint() { return t('action_trashHint'); },
    apply: (messenger, ids, _action, onProgress) =>
      inBatches(ids, (batch) => messenger.messages.delete(batch, false), onProgress),
  },
  {
    id: 'move',
    get label() { return t('action_move'); },
    needsFolder: true,
    terminal: true,
    get hint() { return t('action_moveHint'); },
    apply: (messenger, ids, action, onProgress) =>
      inBatches(ids, (batch) => messenger.messages.move(batch, action.folderId), onProgress),
  },
  {
    id: 'archive',
    get label() { return t('action_archive'); },
    needsFolder: false,
    terminal: true,
    get hint() { return t('action_archiveHint'); },
    apply: (messenger, ids, _action, onProgress) =>
      inBatches(ids, (batch) => messenger.messages.archive(batch), onProgress),
  },
  {
    id: 'copy',
    get label() { return t('action_copy'); },
    needsFolder: true,
    get hint() { return t('action_copyHint'); },
    apply: (messenger, ids, action, onProgress) =>
      inBatches(ids, (batch) => messenger.messages.copy(batch, action.folderId), onProgress),
  },
  {
    id: 'tag',
    get label() { return t('action_tag'); },
    needsTag: true,
    get hint() { return t('action_tagHint'); },
    apply: applyTag,
  },
  {
    id: 'markRead',
    get label() { return t('action_markRead'); },
    needsFolder: false,
    get hint() { return t('action_markReadHint'); },
    apply: (messenger, ids) => Promise.all(ids.map((id) => messenger.messages.update(id, { read: true }))),
  },
  {
    id: 'markUnread',
    get label() { return t('action_markUnread'); },
    needsFolder: false,
    get hint() { return t('action_markUnreadHint'); },
    apply: (messenger, ids) => Promise.all(ids.map((id) => messenger.messages.update(id, { read: false }))),
  },
  {
    id: 'markFlagged',
    get label() { return t('action_markFlagged'); },
    needsFolder: false,
    get hint() { return t('action_markFlaggedHint'); },
    apply: (messenger, ids) => Promise.all(ids.map((id) => messenger.messages.update(id, { flagged: true }))),
  },
  {
    id: 'markUnflagged',
    get label() { return t('action_markUnflagged'); },
    needsFolder: false,
    get hint() { return t('action_markUnflaggedHint'); },
    apply: (messenger, ids) => Promise.all(ids.map((id) => messenger.messages.update(id, { flagged: false }))),
  },
  {
    id: 'markJunk',
    get label() { return t('action_markJunk'); },
    needsFolder: false,
    get hint() { return t('action_markJunkHint'); },
    apply: (messenger, ids) => Promise.all(ids.map((id) => messenger.messages.update(id, { junk: true }))),
  },
  {
    id: 'markNotJunk',
    get label() { return t('action_markNotJunk'); },
    needsFolder: false,
    get hint() { return t('action_markNotJunkHint'); },
    apply: (messenger, ids) => Promise.all(ids.map((id) => messenger.messages.update(id, { junk: false }))),
  },
  {
    id: 'deletePermanently',
    get label() { return t('action_deletePermanently'); },
    needsFolder: false,
    terminal: true,
    danger: true,
    get hint() { return t('action_deletePermanentlyHint'); },
    apply: (messenger, ids, _action, onProgress) =>
      inBatches(ids, (batch) => messenger.messages.delete(batch, true), onProgress),
  },
];

export const ACTIONS_BY_ID = Object.freeze(Object.fromEntries(ACTIONS.map((a) => [a.id, a])));

export const isTerminalAction = (action) => ACTIONS_BY_ID[action?.type]?.terminal === true;

/**
 * A rule's actions, oldest schema included.
 *
 * Rules stored before 0.3.2 carry a single `action` object. Everything reads
 * rules through this helper so an un-migrated rule, an imported file, or an
 * export from an older version all behave the same.
 */
export function actionsOf(rule) {
  if (Array.isArray(rule?.actions) && rule.actions.length > 0) return rule.actions;
  return rule?.action ? [rule.action] : [];
}

/**
 * Execution order: everything that leaves the message where it is runs first,
 * and the one action that consumes it runs last.
 *
 * This is derived rather than taken from the user's ordering because a move
 * invalidates the message ids: "move to Friends, then tag as Friends" would
 * quietly tag nothing. Unknown types are left in place so `runAction` can throw
 * on them instead of them being silently dropped here.
 */
export function orderActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return [...list.filter((a) => !isTerminalAction(a)), ...list.filter(isTerminalAction)];
}

/**
 * Execute a configured action against the matched message ids. No-op on empty input.
 *
 * `onProgress(done, total)` is told about each group of a batched action. See
 * `inBatches`.
 */
export async function runAction(messenger, ids, action, onProgress) {
  if (!ids || ids.length === 0) return;
  const def = ACTIONS_BY_ID[action?.type];
  if (!def) throw new Error(`Unknown action: ${action?.type}`);
  if (def.needsFolder && !action.folderId) {
    throw new Error(`Action "${def.id}" requires a destination folder`);
  }
  if (def.needsTag && !action.tagKey) {
    throw new Error(`Action "${def.id}" requires a tag`);
  }
  await def.apply(messenger, ids, action, onProgress);
}

/**
 * Run every action of a rule against the same matched ids, terminal action last.
 *
 * Sequential on purpose: "tag, then move" has to finish tagging before the
 * message leaves the folder. `onProgress(action, done, total)` names the
 * action each group belongs to.
 */
export async function runActions(messenger, ids, actions, onProgress) {
  if (!ids || ids.length === 0) return;
  const ordered = orderActions(actions);
  if (ordered.length === 0) throw new Error('Rule has no action');
  for (const action of ordered) {
    await runAction(messenger, ids, action, (done, total) => onProgress?.(action, done, total));
  }
}
