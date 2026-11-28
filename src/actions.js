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
 * Uses `Promise.allSettled` per wave so one broken or missing message never
 * aborts the rest of a bulk tag/mark action. Individual failures are handed to
 * `onItemError(id, error)` so callers can exclude those ids from downstream
 * actions and hold the scan watermark. If every single item in a wave fails
 * (e.g. Thunderbird IPC/offline failure), the loop aborts immediately with the
 * first error rather than hammering Thunderbird across remaining waves.
 *
 * Progress is reported at the same `BATCH_SIZE` cadence as bulk actions so a
 * large tag or mark run stays quiet on normal folders and still leaves a clear
 * trail in diagnostics if a huge manual run stalls.
 */
async function inUpdateBatches(ids, fn, { onProgress, onItemError } = {}) {
  let reported = 0;
  let firstError = null;
  for (let i = 0; i < ids.length; i += UPDATE_BATCH_SIZE) {
    const chunk = ids.slice(i, i + UPDATE_BATCH_SIZE);
    const settled = await Promise.allSettled(chunk.map((id) => fn(id)));
    let waveFailures = 0;
    settled.forEach((res, idx) => {
      if (res.status === 'rejected') {
        waveFailures += 1;
        if (firstError === null) firstError = res.reason;
        onItemError?.(chunk[idx], res.reason);
      }
    });
    if (waveFailures === chunk.length) {
      throw firstError;
    }
    const done = i + chunk.length;
    if (ids.length > BATCH_SIZE && (done - reported >= BATCH_SIZE || done === ids.length)) {
      reported = done;
      await onProgress?.(done, ids.length);
    }
  }
  if (firstError !== null && !onItemError) {
    throw firstError;
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
async function applyTag(messenger, ids, action, { onProgress, onItemError, stateById } = {}) {
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
    { onProgress, onItemError },
  );
  return acted;
}

/**
 * Remove one tag without disturbing any other tags on the message.
 *
 * Reuses scanned headers (`stateById`) just like `applyTag`, skipping both
 * `messages.get` and no-op updates for messages that do not carry the tag.
 */
async function applyRemoveTag(messenger, ids, action, { onProgress, onItemError, stateById } = {}) {
  const todo = stateById
    ? ids.filter((id) => {
        const known = stateById.get(id)?.tags;
        return !Array.isArray(known) || known.includes(action.tagKey);
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
      if (!tags.includes(action.tagKey)) return;
      const nextTags = tags.filter((k) => k !== action.tagKey);
      await messenger.messages.update(id, { tags: nextTags });
      if (state) state.tags = nextTags;
      else if (stateById) stateById.set(id, { tags: nextTags });
      acted.push(id);
    },
    { onProgress, onItemError },
  );
  return acted;
}

/**
 * Remove every tag from each matched message, skipping messages already known
 * to carry no tags.
 */
async function applyClearTags(messenger, ids, _action, { onProgress, onItemError, stateById } = {}) {
  const todo = stateById
    ? ids.filter((id) => {
        const known = stateById.get(id)?.tags;
        return !Array.isArray(known) || known.length > 0;
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
      if (tags.length === 0) return;
      await messenger.messages.update(id, { tags: [] });
      if (state) state.tags = [];
      else if (stateById) stateById.set(id, { tags: [] });
      acted.push(id);
    },
    { onProgress, onItemError },
  );
  return acted;
}

/**
 * Set one boolean message flag (`read`, `flagged`, or `junk`) in throttled
 * waves. When `skipUnchanged` is true, messages already known to be in the
 * desired state are skipped. `markNotJunk` passes `skipUnchanged: false`
 * because Thunderbird reports `junk: false` for both explicitly Not Junk and
 * unclassified mail, so skipping it would never classify unclassified mail as
 * good.
 */
function applyMark(prop, value, { skipUnchanged = true } = {}) {
  return async (messenger, ids, _action, { onProgress, onItemError, stateById } = {}) => {
    const todo = skipUnchanged && stateById
      ? ids.filter((id) => stateById.get(id)?.[prop] !== value)
      : ids;
    if (todo.length === 0) return [];
    const acted = [];
    await inUpdateBatches(
      todo,
      async (id) => {
        await messenger.messages.update(id, { [prop]: value });
        const state = stateById?.get(id);
        if (state) state[prop] = value;
        acted.push(id);
      },
      { onProgress, onItemError },
    );
    return acted;
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
    id: 'removeTag',
    get label() { return t('action_removeTag'); },
    needsTag: true,
    get hint() { return t('action_removeTagHint'); },
    apply: applyRemoveTag,
  },
  {
    id: 'clearTags',
    get label() { return t('action_clearTags'); },
    needsFolder: false,
    get hint() { return t('action_clearTagsHint'); },
    apply: applyClearTags,
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
    apply: applyMark('junk', false, { skipUnchanged: false }),
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
 * Execution order: tag clears and removals run before tag additions and other
 * in-place updates, and the one action that consumes the message runs last.
 *
 * This is derived rather than taken from the user's ordering because a move
 * invalidates the message ids ("move to Friends, then tag as Friends" would
 * quietly tag nothing), and because "clear/remove tags, then add tag" lets a
 * rule swap tags predictably regardless of row order. Unknown types are left
 * in place so `runAction` can throw on them instead of them being silently
 * dropped here.
 */
function actionPhase(action) {
  if (isTerminalAction(action)) return 3;
  if (action?.type === 'clearTags') return 0;
  if (action?.type === 'removeTag') return 1;
  return 2;
}

export function orderActions(actions) {
  const list = Array.isArray(actions) ? actions : [];
  return list
    .map((action, index) => ({ action, index, phase: actionPhase(action) }))
    .sort((a, b) => a.phase - b.phase || a.index - b.index)
    .map((entry) => entry.action);
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
    onItemError: options.onItemError,
    stateById,
  })) ?? targetIds;
}

/**
 * Run every action of a rule against the same matched ids, terminal action last.
 *
 * Sequential on purpose: "tag, then move" has to finish tagging before the
 * message leaves the folder. If one message fails an earlier per-message update
 * (such as tagging), healthy messages still complete the rule while the failed
 * message is excluded from later actions (so it is never moved untagged) and
 * reported in `errors` so the caller logs it and holds the scan watermark.
 *
 * Returns `{ affected, actedIds, errors }`.
 */
export async function runActions(messenger, ids, actions, optionsOrProgress) {
  if (!ids || ids.length === 0) return { affected: 0, actedIds: [], errors: [] };
  const ordered = orderActions(actions);
  if (ordered.length === 0) throw new Error('Rule has no action');
  const options = normalizeOptions(optionsOrProgress);
  const stateById = snapshotState(options.headers);
  const acted = new Set();
  const failedIds = new Set();
  const errors = [];
  for (const action of ordered) {
    const eligible = failedIds.size > 0 ? ids.filter((id) => !failedIds.has(id)) : ids;
    if (eligible.length === 0) break;
    const ran = await runAction(messenger, eligible, action, {
      onProgress: options.onProgress && ((done, total) => options.onProgress(action, done, total)),
      onBatch: options.onBatch && ((batch) => options.onBatch(action, batch)),
      onItemError: (id, error) => {
        failedIds.add(id);
        errors.push({ id, action: action.type, error });
      },
      filterIds: options.filterIds && ((candidateIds) => options.filterIds(action, candidateIds)),
      stateById,
    });
    for (const id of ran) acted.add(id);
  }
  return { affected: acted.size, actedIds: [...acted], errors };
}
