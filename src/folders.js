/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which folders a rule scans, and how the folder picker filters its list.
 *
 * Pure and free of extension APIs, like matcher.js. The background script hands
 * in the folder list from `folders.query()`; each entry needs `id`, `accountId`
 * and `path`, plus `specialUse` when Thunderbird reports it.
 */

import { actionsOf } from './actions.js';

/** `/INBOX/Work/2024` is at depth 3. */
export function folderDepth(path) {
  return String(path ?? '').split('/').filter(Boolean).length;
}

function isDescendant(folder, parent) {
  if (folder.accountId !== parent.accountId || !parent.path || parent.path === '/') return false;
  return String(folder.path ?? '').startsWith(`${parent.path}/`);
}

/**
 * The folder ids a rule scans, in a stable order and without repeats.
 *
 * Without `includeSubfolders` this is the rule's own list. With it, every folder
 * under a chosen one is added at run time, so a subfolder created later is
 * covered without editing the rule.
 *
 * Two kinds of subfolder are left out, because scanning them would loop or lose
 * mail. A folder the rule moves or copies into would be scanned again on the
 * next run, and a copy would duplicate the mail every time. A Trash folder is
 * skipped because some servers nest it under the Inbox, and "Move to Trash" on
 * mail already in Trash deletes it for good. A folder the user picked by hand is
 * always kept: that choice was deliberate.
 */
export function resolveRuleFolders(rule, allFolders = []) {
  const chosen = (rule?.folderIds ?? []).map(String);
  if (rule?.includeSubfolders !== true) return [...new Set(chosen)];

  const byId = new Map(allFolders.filter((f) => f?.id).map((f) => [String(f.id), f]));
  const destinations = new Set(
    actionsOf(rule).filter((a) => a?.folderId).map((a) => String(a.folderId)),
  );
  const result = [];
  const seen = new Set();
  const add = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };

  for (const id of chosen) {
    add(id);
    const parent = byId.get(id);
    if (!parent) continue;
    for (const folder of allFolders) {
      if (!folder?.id || !isDescendant(folder, parent)) continue;
      const childId = String(folder.id);
      if (destinations.has(childId)) continue;
      if ((folder.specialUse ?? []).includes('trash')) continue;
      add(childId);
    }
  }
  return result;
}

/**
 * Whether a folder matches the picker's filter text.
 *
 * Every word must appear somewhere in the account name or the folder path,
 * ignoring case, so "work 2024" finds `/INBOX/Work/2024` in any account.
 */
export function folderMatchesFilter(folder, text) {
  const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${folder?.accountName ?? ''} ${folder?.path ?? ''}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

/**
 * Where to draw the dashed tree lines for each folder in a flat, tree-ordered
 * list (each account's folders in the order `folders.query()` returns them).
 *
 * For a folder at depth d, `through` has d - 1 entries, one per level from the
 * outermost: true means a line passes through this row at that level, because
 * the folder above it on that level has more siblings still to come. The last
 * entry is the folder's own level; there `last` says whether the line stops at
 * this row (the folder is its parent's last child) or carries on below it.
 */
export function treeGuides(folders) {
  const key = (accountId, path) => `${accountId}\u0000${path}`;
  const parentOf = (path) => path.slice(0, path.lastIndexOf('/')) || '/';
  const lastChild = new Map();
  for (const f of folders) lastChild.set(key(f.accountId, parentOf(f.path)), f.id);
  const isLast = (accountId, path) => {
    const id = lastChild.get(key(accountId, parentOf(path)));
    return id === undefined || byPath.get(key(accountId, path)) === id;
  };
  const byPath = new Map(folders.map((f) => [key(f.accountId, f.path), f.id]));

  const guides = new Map();
  for (const f of folders) {
    const parts = String(f.path ?? '').split('/').filter(Boolean);
    const through = [];
    // Levels 2..d: the ancestor (or the folder itself) at that depth decides
    // whether its parent's line continues past this row.
    for (let depth = 2; depth <= parts.length; depth += 1) {
      const path = `/${parts.slice(0, depth).join('/')}`;
      through.push(!isLast(f.accountId, path));
    }
    guides.set(f.id, { through, last: through.length > 0 && !through[through.length - 1] });
  }
  return guides;
}
