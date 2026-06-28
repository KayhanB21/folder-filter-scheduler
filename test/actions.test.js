/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, ACTIONS_BY_ID, runAction } from '../src/actions.js';

/** A messenger double that records the calls each action makes. */
function fakeMessenger() {
  const calls = [];
  const rec = (name) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve();
  };
  return {
    calls,
    messages: {
      delete: rec('delete'),
      move: rec('move'),
      copy: rec('copy'),
      update: rec('update'),
    },
  };
}

test('every action descriptor is well-formed', () => {
  for (const def of ACTIONS) {
    assert.equal(typeof def.id, 'string');
    assert.equal(typeof def.label, 'string');
    assert.equal(typeof def.hint, 'string');
    assert.equal(typeof def.apply, 'function');
  }
  // No duplicate ids.
  assert.equal(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length);
});

test('trash moves to the account Trash (skipTrash=false)', async () => {
  const m = fakeMessenger();
  await runAction(m, [1, 2], { type: 'trash' });
  assert.deepEqual(m.calls, [{ name: 'delete', args: [[1, 2], false] }]);
});

test('deletePermanently uses skipTrash=true and is flagged danger', async () => {
  const m = fakeMessenger();
  await runAction(m, [9], { type: 'deletePermanently' });
  assert.deepEqual(m.calls, [{ name: 'delete', args: [[9], true] }]);
  assert.equal(ACTIONS_BY_ID.deletePermanently.danger, true);
});

test('cross-account move passes the chosen destination folder to messages.move', async () => {
  const m = fakeMessenger();
  // Source folder is Yahoo Bulk; destination is an Outlook Trash folder id.
  await runAction(m, [5], { type: 'move', folderId: 'outlook:/Trash' });
  assert.deepEqual(m.calls, [{ name: 'move', args: [[5], 'outlook:/Trash'] }]);
});

test('a folder-requiring action without a folder throws (and runs nothing)', async () => {
  const m = fakeMessenger();
  await assert.rejects(() => runAction(m, [1], { type: 'move' }), /requires a destination folder/);
  assert.equal(m.calls.length, 0);
});

test('mark actions update every id individually', async () => {
  const m = fakeMessenger();
  await runAction(m, [1, 2, 3], { type: 'markRead' });
  assert.equal(m.calls.length, 3);
  assert.ok(m.calls.every((c) => c.name === 'update'));
});

test('empty id list is a no-op', async () => {
  const m = fakeMessenger();
  await runAction(m, [], { type: 'trash' });
  assert.equal(m.calls.length, 0);
});

test('unknown action type throws', async () => {
  const m = fakeMessenger();
  await assert.rejects(() => runAction(m, [1], { type: 'nope' }), /Unknown action/);
});
