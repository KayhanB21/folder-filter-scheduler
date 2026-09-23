/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderDepth, folderMatchesFilter, resolveRuleFolders, treeGuides } from '../src/folders.js';

const f = (accountId, path, specialUse) => ({ id: `${accountId}:/${path}`, accountId, path: `/${path}`, specialUse });

const all = [
  f('a', 'INBOX'),
  f('a', 'INBOX/Work'),
  f('a', 'INBOX/Work/2024'),
  f('a', 'INBOX/Trash', ['trash']),
  f('a', 'INBOXES'),
  f('a', 'Archive'),
  f('b', 'INBOX'),
  f('b', 'INBOX/Work'),
];

const rule = (extra) => ({ folderIds: ['a:/INBOX'], actions: [{ type: 'markRead' }], ...extra });

test('without includeSubfolders the chosen folders are all that is scanned', () => {
  assert.deepEqual(resolveRuleFolders(rule(), all), ['a:/INBOX']);
});

test('includeSubfolders adds every folder under a chosen one, at any depth', () => {
  assert.deepEqual(resolveRuleFolders(rule({ includeSubfolders: true }), all), [
    'a:/INBOX',
    'a:/INBOX/Work',
    'a:/INBOX/Work/2024',
  ]);
});

test('a sibling that shares a name prefix is not a subfolder', () => {
  assert.ok(!resolveRuleFolders(rule({ includeSubfolders: true }), all).includes('a:/INBOXES'));
});

test('subfolders stay within the chosen folder account', () => {
  assert.ok(!resolveRuleFolders(rule({ includeSubfolders: true }), all).includes('b:/INBOX/Work'));
});

test('a Trash folder nested under a chosen folder is skipped', () => {
  assert.ok(!resolveRuleFolders(rule({ includeSubfolders: true }), all).includes('a:/INBOX/Trash'));
});

test('a subfolder the rule moves or copies into is skipped, so mail is not rescanned', () => {
  for (const type of ['move', 'copy']) {
    const r = rule({ includeSubfolders: true, actions: [{ type, folderId: 'a:/INBOX/Work' }] });
    assert.deepEqual(resolveRuleFolders(r, all), ['a:/INBOX', 'a:/INBOX/Work/2024'], type);
  }
});

test('a folder the user chose by hand is kept even if it is a destination or Trash', () => {
  const r = rule({
    includeSubfolders: true,
    folderIds: ['a:/INBOX', 'a:/INBOX/Trash'],
    actions: [{ type: 'move', folderId: 'a:/INBOX/Work' }],
  });
  assert.deepEqual(resolveRuleFolders(r, all), ['a:/INBOX', 'a:/INBOX/Work/2024', 'a:/INBOX/Trash']);
});

test('overlapping choices produce each folder once', () => {
  const r = rule({ includeSubfolders: true, folderIds: ['a:/INBOX', 'a:/INBOX/Work'] });
  assert.deepEqual(resolveRuleFolders(r, all), ['a:/INBOX', 'a:/INBOX/Work', 'a:/INBOX/Work/2024']);
});

test('a chosen folder missing from the list is still scanned, with no subfolders', () => {
  const r = rule({ includeSubfolders: true, folderIds: ['gone'] });
  assert.deepEqual(resolveRuleFolders(r, all), ['gone']);
});

test('folderDepth counts path segments', () => {
  assert.equal(folderDepth('/INBOX'), 1);
  assert.equal(folderDepth('/INBOX/Work/2024'), 3);
  assert.equal(folderDepth(''), 0);
});

test('the filter needs every word somewhere in the account name or path', () => {
  const folder = { accountName: 'Yahoo', path: '/INBOX/Work/2024' };
  assert.equal(folderMatchesFilter(folder, ''), true);
  assert.equal(folderMatchesFilter(folder, 'work'), true);
  assert.equal(folderMatchesFilter(folder, 'WORK 2024'), true);
  assert.equal(folderMatchesFilter(folder, 'yahoo work'), true);
  assert.equal(folderMatchesFilter(folder, 'work 2023'), false);
});

test('treeGuides draws a line on through rows and stops it at the last child', () => {
  const list = [
    f('a', 'INBOX'),
    f('a', 'INBOX/Family'),
    f('a', 'INBOX/Family/School'),
    f('a', 'INBOX/Projects'),
    f('a', 'INBOX/Projects/House'),
    f('a', 'Archive'),
  ];
  const g = treeGuides(list);
  assert.deepEqual(g.get('a:/INBOX'), { through: [], last: false });
  // Family has a later sibling (Projects), so the INBOX line runs on.
  assert.deepEqual(g.get('a:/INBOX/Family'), { through: [true], last: false });
  // School is Family's only child: its own line stops, INBOX's continues.
  assert.deepEqual(g.get('a:/INBOX/Family/School'), { through: [true, false], last: true });
  assert.deepEqual(g.get('a:/INBOX/Projects'), { through: [false], last: true });
  assert.deepEqual(g.get('a:/INBOX/Projects/House'), { through: [false, false], last: true });
});

test('treeGuides keeps accounts apart', () => {
  const g = treeGuides([f('a', 'INBOX'), f('a', 'INBOX/Work'), f('b', 'INBOX'), f('b', 'INBOX/Work')]);
  assert.equal(g.get('a:/INBOX/Work').last, true);
  assert.equal(g.get('b:/INBOX/Work').last, true);
});
