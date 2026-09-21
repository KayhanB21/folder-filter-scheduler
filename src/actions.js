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
 */

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
    label: "Move to Trash (each message's own account)",
    needsFolder: false,
    terminal: true,
    hint: 'Routes each matched message to the Trash of its own account — safe across multi-account rules.',
    apply: (messenger, ids) => messenger.messages.delete(ids, false),
  },
  {
    id: 'move',
    label: 'Move to folder…',
    needsFolder: true,
    terminal: true,
    hint: 'Sends every match to the chosen folder — including a folder in a different account (Thunderbird copies to the target account, then deletes the source).',
    apply: (messenger, ids, action) => messenger.messages.move(ids, action.folderId),
  },
  {
    id: 'archive',
    label: 'Archive',
    needsFolder: false,
    terminal: true,
    hint: "Archives each message the way Thunderbird's Archive button does, using its own account's archive settings. An account with archiving turned off keeps its mail in place.",
    apply: (messenger, ids) => messenger.messages.archive(ids),
  },
  {
    id: 'copy',
    label: 'Copy to folder…',
    needsFolder: true,
    hint: 'Leaves the original in place and copies a duplicate into the chosen folder (works across accounts too).',
    apply: (messenger, ids, action) => messenger.messages.copy(ids, action.folderId),
  },
  {
    id: 'tag',
    label: 'Tag as…',
    needsTag: true,
    hint: 'Adds one of your Thunderbird tags. Tags already on the message are kept, so several rules can tag the same mail.',
    apply: applyTag,
  },
  {
    id: 'markRead',
    label: 'Mark as read',
    needsFolder: false,
    hint: 'Marks matches as read without moving them.',
    apply: (messenger, ids) => Promise.all(ids.map((id) => messenger.messages.update(id, { read: true }))),
  },
  {
    id: 'markFlagged',
    label: 'Flag',
    needsFolder: false,
    hint: 'Flags matches without moving them.',
    apply: (messenger, ids) => Promise.all(ids.map((id) => messenger.messages.update(id, { flagged: true }))),
  },
  {
    id: 'markJunk',
    label: 'Mark as junk',
    needsFolder: false,
    hint: 'Marks matches as junk (does not move them — Thunderbird’s junk handling decides the rest).',
    apply: (messenger, ids) => Promise.all(ids.map((id) => messenger.messages.update(id, { junk: true }))),
  },
  {
    id: 'deletePermanently',
    label: 'Delete permanently',
    needsFolder: false,
    terminal: true,
    danger: true,
    hint: 'Skips the Trash and deletes matches immediately. This cannot be undone.',
    apply: (messenger, ids) => messenger.messages.delete(ids, true),
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

/** Execute a configured action against the matched message ids. No-op on empty input. */
export async function runAction(messenger, ids, action) {
  if (!ids || ids.length === 0) return;
  const def = ACTIONS_BY_ID[action?.type];
  if (!def) throw new Error(`Unknown action: ${action?.type}`);
  if (def.needsFolder && !action.folderId) {
    throw new Error(`Action "${def.id}" requires a destination folder`);
  }
  if (def.needsTag && !action.tagKey) {
    throw new Error(`Action "${def.id}" requires a tag`);
  }
  await def.apply(messenger, ids, action);
}

/**
 * Run every action of a rule against the same matched ids, terminal action last.
 *
 * Sequential on purpose: "tag, then move" has to finish tagging before the
 * message leaves the folder.
 */
export async function runActions(messenger, ids, actions) {
  if (!ids || ids.length === 0) return;
  const ordered = orderActions(actions);
  if (ordered.length === 0) throw new Error('Rule has no action');
  for (const action of ordered) {
    await runAction(messenger, ids, action);
  }
}
