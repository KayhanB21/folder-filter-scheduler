/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARD_VERDICTS, createStopGuard } from '../src/stop-guard.js';

const boss = { id: 'boss', folderIds: ['inbox'], stopProcessing: true };
const lists = { id: 'lists', folderIds: ['inbox', 'lists'], stopProcessing: true };
const plain = { id: 'plain', folderIds: ['inbox'] };
const cleanup = { id: 'cleanup', folderIds: ['inbox', 'lists'] };
const foldersOf = (rule) => rule.folderIds;

/** A guard whose stopping rules answer from a table, and the calls it made. */
function guardWith(rules, answers = {}) {
  const calls = [];
  const guard = createStopGuard({
    rules,
    foldersOf,
    evaluate: (stopRule, header) => {
      calls.push(`${stopRule.id}:${header.id}`);
      return Object.hasOwn(answers, stopRule.id) ? answers[stopRule.id] : false;
    },
  });
  return { guard, calls };
}

test('only an enabled stopping rule ordered before the rule guards it', () => {
  const off = { id: 'off', folderIds: ['inbox'], stopProcessing: true, enabled: false };
  const late = { id: 'late', folderIds: ['inbox'], stopProcessing: true };
  const { guard } = guardWith([boss, plain, off, cleanup, late]);
  assert.deepEqual(guard.guardsFor(cleanup, 'inbox'), [boss]);
  assert.deepEqual(guard.guardsFor(boss, 'inbox'), []);
  assert.deepEqual(guard.guardsFor(late, 'inbox'), [boss]);
});

test('a stopping rule guards only the folders it watches', () => {
  const { guard } = guardWith([boss, lists, cleanup]);
  assert.deepEqual(guard.guardsFor(cleanup, 'inbox'), [boss, lists]);
  assert.deepEqual(guard.guardsFor(cleanup, 'lists'), [lists]);
  assert.deepEqual(guard.guardsFor(cleanup, 'archive'), []);
  assert.deepEqual(guard.guardsAcross(cleanup, ['lists', 'archive']), [lists]);
  assert.deepEqual(guard.guardsAcross(cleanup, ['archive']), []);
});

test('a rule that is not in the saved list has no guards', () => {
  const { guard } = guardWith([boss, cleanup]);
  assert.deepEqual(guard.guardsFor({ ...cleanup }, 'inbox'), []);
});

test('a message that no earlier stopping rule matches is clear', async () => {
  const { guard, calls } = guardWith([boss, lists, cleanup]);
  assert.equal(await guard.check(cleanup, 'inbox', { id: 7 }), GUARD_VERDICTS.clear);
  assert.deepEqual(calls, ['boss:7', 'lists:7']);
});

test('a match by an earlier stopping rule stops the rule, and ends the check', async () => {
  const { guard, calls } = guardWith([boss, lists, cleanup], { boss: true });
  assert.equal(await guard.check(cleanup, 'inbox', { id: 7 }), GUARD_VERDICTS.stopped);
  assert.deepEqual(calls, ['boss:7']);
});

test('a stopping rule that does not watch the folder is not asked', async () => {
  const { guard, calls } = guardWith([boss, cleanup], { boss: true });
  assert.equal(await guard.check(cleanup, 'lists', { id: 7 }), GUARD_VERDICTS.clear);
  assert.deepEqual(calls, []);
});

test('an unread message is unknown, unless another stopping rule matches it', async () => {
  const unread = guardWith([boss, lists, cleanup], { boss: null });
  assert.equal(await unread.guard.check(cleanup, 'inbox', { id: 7 }), GUARD_VERDICTS.unknown);

  const matched = guardWith([boss, lists, cleanup], { boss: null, lists: true });
  assert.equal(await matched.guard.check(cleanup, 'inbox', { id: 7 }), GUARD_VERDICTS.stopped);
});

test('an evaluation that throws is unknown and is reported', async () => {
  const errors = [];
  const guard = createStopGuard({
    rules: [boss, cleanup],
    foldersOf,
    evaluate: () => {
      throw new Error('read failed');
    },
    onError: (stopRule, e) => errors.push(`${stopRule.id}: ${e.message}`),
  });
  assert.equal(await guard.check(cleanup, 'inbox', { id: 7 }), GUARD_VERDICTS.unknown);
  assert.deepEqual(errors, ['boss: read failed']);
});

test('a run without stopping rules never evaluates anything', async () => {
  const { guard, calls } = guardWith([plain, cleanup], { plain: true });
  assert.equal(await guard.check(cleanup, 'inbox', { id: 7 }), GUARD_VERDICTS.clear);
  assert.deepEqual(calls, []);
});
