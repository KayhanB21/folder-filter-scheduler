/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The single source of truth for actions.
 *
 * Both the background engine (which executes `apply`) and the options UI (which
 * reads `label` / `needsFolder` / `hint` / `danger`) are driven by this list, so
 * adding a new action is a one-entry change — no edits to the engine switch or
 * the HTML <option> list. `apply` receives the injected `messenger` API, the
 * matched message ids, and the action config (e.g. `{ type, folderId }`).
 */
export const ACTIONS = [
  {
    id: 'trash',
    label: "Move to Trash (each message's own account)",
    needsFolder: false,
    hint: 'Routes each matched message to the Trash of its own account — safe across multi-account rules.',
    apply: (messenger, ids) => messenger.messages.delete(ids, false),
  },
  {
    id: 'move',
    label: 'Move to folder…',
    needsFolder: true,
    hint: 'Sends every match to the chosen folder — including a folder in a different account (Thunderbird copies to the target account, then deletes the source).',
    apply: (messenger, ids, action) => messenger.messages.move(ids, action.folderId),
  },
  {
    id: 'copy',
    label: 'Copy to folder…',
    needsFolder: true,
    hint: 'Leaves the original in place and copies a duplicate into the chosen folder (works across accounts too).',
    apply: (messenger, ids, action) => messenger.messages.copy(ids, action.folderId),
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
    danger: true,
    hint: 'Skips the Trash and deletes matches immediately. This cannot be undone.',
    apply: (messenger, ids) => messenger.messages.delete(ids, true),
  },
];

export const ACTIONS_BY_ID = Object.freeze(Object.fromEntries(ACTIONS.map((a) => [a.id, a])));

/** Execute a configured action against the matched message ids. No-op on empty input. */
export async function runAction(messenger, ids, action) {
  if (!ids || ids.length === 0) return;
  const def = ACTIONS_BY_ID[action?.type];
  if (!def) throw new Error(`Unknown action: ${action?.type}`);
  if (def.needsFolder && !action.folderId) {
    throw new Error(`Action "${def.id}" requires a destination folder`);
  }
  await def.apply(messenger, ids, action);
}
