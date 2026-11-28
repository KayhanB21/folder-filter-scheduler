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
 * How many per-message `messages.update` calls may be in flight at once for
 * tag and mark actions.
 *
 * Unlike move or archive (one call per 200 messages), `messages.update` is one
 * call per message. Launching thousands simultaneously with `Promise.all`
 * hammers Thunderbird's IPC and IMAP queues; small sequential waves keep large
 * manual runs responsive without slowing normal runs down.
 */
export const UPDATE_BATCH_SIZE = 25;

/**
 * Call `fn` on `ids` in groups of `BATCH_SIZE`, each after the one before.
 *
 * `onBatch(batch)` runs after each group finishes so callers (such as copy
 * deduplication) can persist progress before the next group starts.
 * `onProgress(done, total)` follows each group when there is more than one: a
 * log line per group then shows where a call that never answers stopped, and a
 * small action adds no lines at all.
 */
async function inBatches(ids, fn, { onProgress, onBatch } = {}) {
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    await fn(batch);
    await onBatch?.(batch);
    if (ids.length > BATCH_SIZE) await onProgress?.(Math.min(i + BATCH_SIZE, ids.length), ids.length);
  }
  return ids;
}

/**
 * Call `fn` on each id in sequential waves of `UPDATE_BATCH_SIZE`.
 *
 * Progress is reported at the same `BATCH_SIZE` cadence as bulk actions so a
 * large tag or mark run stays quiet on normal folders and still leaves a clear
 * trail in diagnostics if a huge manual run stalls.
 */
async function inUpdateBatches(ids, fn, { onProgress } = {}) {
  let reported = 0;
  for (let i = 0; i < ids.length; i += UPDATE_BATCH_SIZE) {
    const chunk = ids.slice(i, i + UPDATE_BATCH_SIZE);
    await Promise.all(chunk.map(fn));
    const done = i + chunk.length;
    if (ids.length > BATCH_SIZE && (done - reported >= BATCH_SIZE || done === ids.length)) {
      reported = done;
      await onProgress?.(done, ids.length);
    }
  }
}

/**
 * Snapshot the mutable message fields from scanned headers so sequential
 * actions in one rule (such as two tag actions) see each other's updates
 * without mutating the caller's MessageHeader objects.
 */
function snapshotState(headers) {
  if (!headers) return null;
  const state = new Map();
  for (const [id, header] of headers) {
    if (!header || typeof header !== 'object') continue;
    state.set(id, {
      read: typeof header.read === 'boolean' ? header.read : undefined,
      flagged: typeof header.flagged === 'boolean' ? header.flagged : undefined,
      junk: typeof header.junk === 'boolean' ? header.junk : undefined,
      tags: Array.isArray(header.tags) ? [...header.tags] : undefined,
    });
  }
  return state;
}

/**
 * Add a tag without disturbing the ones already on the message.
 *
 * `messages.update` replaces the whole tag array. When the caller passes the
 * headers already read during the folder scan (`stateById`), we read the
 * existing tags from there and skip both `messages.get` and any no-op update
 * for messages that already carry the tag. Without `stateById`, each message is
 * read back first as before, still throttled to `UPDATE_BATCH_SIZE` at a time.
 */
async function applyTag(messenger, ids, action, { onProgress, stateById } = {}) {
  const todo = stateById
    ? ids.filter((id) => {
        const known = stateById.get(id)?.tags;
        return !Array.isArray(known) || !known.includes(action.tagKey);
      })
    : ids;
  if (todo.length === 0) return [];

  const acted = [];
  await inUpdateBatches(
    todo,
    async (id) => {
      const state = stateById?.get(id);
      let tags;
      if (Array.isArray(state?.tags)) {
        tags = state.tags;
      } else {
        const header = await messenger.messages.get(id);
        tags = Array.isArray(header?.tags) ? header.tags : [];
      }
      if (tags.includes(action.tagKey)) return;
      const nextTags = [...tags, action.tagKey];
      await messenger.messages.update(id, { tags: nextTags });
      if (state) state.tags = nextTags;
      else if (stateById) stateById.set(id, { tags: nextTags });
      acted.push(id);
    },
    { onProgress },
  );
  return acted;
}

/**
 * Set one boolean message flag (`read`, `flagged`, or `junk`) in throttled
 * waves, skipping messages already known to be in the desired state.
 */
function applyMark(prop, value) {
  return async (messenger, ids, _action, { onProgress, stateById } = {}) => {
    const todo = stateById
      ? ids.filter((id) => stateById.get(id)?.[prop] !== value)
      : ids;
    if (todo.length === 0) return [];
    await inUpdateBatches(
      todo,
      async (id) => {
        await messenger.messages.update(id, { [prop]: value });
        const state = stateById?.get(id);
        if (state) state[prop] = value;
      },
      { onProgress },
    );
    return todo;
  };
}

export const ACTIONS = [
  {
    id: 'trash',
    get label() { return t('action_trash'); },
    needsFolder: false,
    terminal: true,
    get hint() { return t('action_trashHint'); },
    apply: (messenger, ids, _action, options) =>
      inBatches(ids, (batch) => messenger.messages.delete(batch, false), options),
  },
  {
    id: 'move',
    get label() { return t('action_move'); },
    needsFolder: true,
    terminal: true,
    get hint() { return t('action_moveHint'); },
    apply: (messenger, ids, action, options) =>
      inBatches(ids, (batch) => messenger.messages.move(batch, action.folderId), options),
  },
  {
    id: 'archive',
    get label() { return t('action_archive'); },
    needsFolder: false,
    terminal: true,
    get hint() { return t('action_archiveHint'); },
    apply: (messenger, ids, _action, options) =>
      inBatches(ids, (batch) => messenger.messages.archive(batch), options),
  },
  {
    id: 'copy',
    get label() { return t('action_copy'); },
    needsFolder: true,
    get hint() { return t('action_copyHint'); },
    apply: (messenger, ids, action, options) =>
      inBatches(ids, (batch) => messenger.messages.copy(batch, action.folderId), options),
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
    apply: applyMark('read', true),
  },
  {
    id: 'markUnread',
    get label() { return t('action_markUnread'); },
    needsFolder: false,
    get hint() { return t('action_markUnreadHint'); },
    apply: applyMark('read', false),
  },
  {
    id: 'markFlagged',
    get label() { return t('action_markFlagged'); },
    needsFolder: false,
    get hint() { return t('action_markFlaggedHint'); },
    apply: applyMark('flagged', true),
  },
  {
    id: 'markUnflagged',
    get label() { return t('action_markUnflagged'); },
    needsFolder: false,
    get hint() { return t('action_markUnflaggedHint'); },
    apply: applyMark('flagged', false),
  },
  {
    id: 'markJunk',
    get label() { return t('action_markJunk'); },
    needsFolder: false,
    get hint() { return t('action_markJunkHint'); },
    apply: applyMark('junk', true),
  },
  {
    id: 'markNotJunk',
    get label() { return t('action_markNotJunk'); },
    needsFolder: false,
    get hint() { return t('action_markNotJunkHint'); },
    apply: applyMark('junk', false),
  },
  {
    id: 'deletePermanently',
    get label() { return t('action_deletePermanently'); },
    needsFolder: false,
    terminal: true,
    danger: true,
    get hint() { return t('action_deletePermanentlyHint'); },
    apply: (messenger, ids, _action, options) =>
      inBatches(ids, (batch) => messenger.messages.delete(batch, true), options),
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

function normalizeOptions(optionsOrProgress) {
  if (typeof optionsOrProgress === 'function') return { onProgress: optionsOrProgress };
  return optionsOrProgress ?? {};
}

/**
 * Execute a configured action against the matched message ids. No-op on empty input.
 * Returns the message ids the action actually modified or moved/copied.
 *
 * The fourth argument may be `onProgress(done, total)` or an options object
 * `{ onProgress, onBatch, filterIds, headers, stateById }`.
 */
export async function runAction(messenger, ids, action, optionsOrProgress) {
  if (!ids || ids.length === 0) return [];
  const def = ACTIONS_BY_ID[action?.type];
  if (!def) throw new Error(`Unknown action: ${action?.type}`);
  if (def.needsFolder && !action.folderId) {
    throw new Error(`Action "${def.id}" requires a destination folder`);
  }
  if (def.needsTag && !action.tagKey) {
    throw new Error(`Action "${def.id}" requires a tag`);
  }
  const options = normalizeOptions(optionsOrProgress);
  const targetIds = options.filterIds ? await options.filterIds(ids) : ids;
  if (!targetIds || targetIds.length === 0) return [];
  const stateById = options.stateById ?? snapshotState(options.headers);
  return (await def.apply(messenger, targetIds, action, {
    onProgress: options.onProgress,
    onBatch: options.onBatch,
    stateById,
  })) ?? targetIds;
}

/**
 * Run every action of a rule against the same matched ids, terminal action last.
 *
 * Sequential on purpose: "tag, then move" has to finish tagging before the
 * message leaves the folder. The fourth argument may be
 * `onProgress(action, done, total)` or `{ onProgress, onBatch, filterIds, headers }`.
 * Returns `{ affected, actedIds }`, counting distinct messages at least one
 * action actually touched.
 */
export async function runActions(messenger, ids, actions, optionsOrProgress) {
  if (!ids || ids.length === 0) return { affected: 0, actedIds: [] };
  const ordered = orderActions(actions);
  if (ordered.length === 0) throw new Error('Rule has no action');
  const options = normalizeOptions(optionsOrProgress);
  const stateById = snapshotState(options.headers);
  const acted = new Set();
  for (const action of ordered) {
    const ran = await runAction(messenger, ids, action, {
      onProgress: options.onProgress && ((done, total) => options.onProgress(action, done, total)),
      onBatch: options.onBatch && ((batch) => options.onBatch(action, batch)),
      filterIds: options.filterIds && ((candidateIds) => options.filterIds(action, candidateIds)),
      stateById,
    });
    for (const id of ran) acted.add(id);
  }
  return { affected: acted.size, actedIds: [...acted] };
}
