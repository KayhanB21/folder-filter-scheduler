/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, ACTIONS_BY_ID, actionsOf, orderActions, runAction, runActions } from '../src/actions.js';

/**
 * A messenger double that records the calls each action makes.
 *
 * `tagsById` seeds what `messages.get` reports, so the tag action can be tested
 * for the thing that matters: it must not wipe tags that are already there.
 */
function fakeMessenger(tagsById = {}) {
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
      get: (id) => Promise.resolve({ id, tags: tagsById[id] ?? [] }),
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

test('tagging keeps the tags a message already carries', async () => {
  const m = fakeMessenger({ 1: ['$label3'], 2: [] });
  await runAction(m, [1, 2], { type: 'tag', tagKey: '$label1' });
  const updates = m.calls.filter((c) => c.name === 'update');
  assert.deepEqual(
    updates.map((c) => c.args).sort((a, b) => a[0] - b[0]),
    [
      [1, { tags: ['$label3', '$label1'] }],
      [2, { tags: ['$label1'] }],
    ],
  );
});

test('tagging a message that already has the tag writes nothing', async () => {
  const m = fakeMessenger({ 7: ['$label1'] });
  await runAction(m, [7], { type: 'tag', tagKey: '$label1' });
  assert.equal(m.calls.filter((c) => c.name === 'update').length, 0);
});

test('a tag action without a tag throws (and runs nothing)', async () => {
  const m = fakeMessenger();
  await assert.rejects(() => runAction(m, [1], { type: 'tag' }), /requires a tag/);
  assert.equal(m.calls.filter((c) => c.name === 'update').length, 0);
});

test('the action that consumes the message always runs last', async () => {
  // Written move-then-tag, which would tag nothing: the move invalidates the ids.
  const m = fakeMessenger({ 1: [] });
  await runActions(m, [1], [
    { type: 'move', folderId: 'friends' },
    { type: 'tag', tagKey: '$label1' },
  ]);
  // messages.get is not recorded; the update (the tag) lands before the move.
  assert.deepEqual(
    m.calls.map((c) => c.name),
    ['update', 'move'],
  );
});

test('orderActions leaves an unknown type in place for runAction to reject', async () => {
  assert.deepEqual(orderActions([{ type: 'nope' }, { type: 'trash' }]), [
    { type: 'nope' },
    { type: 'trash' },
  ]);
  const m = fakeMessenger();
  await assert.rejects(() => runActions(m, [1], [{ type: 'nope' }]), /Unknown action/);
});

test('copy is not terminal, so it can precede a move', () => {
  assert.equal(ACTIONS_BY_ID.copy.terminal, undefined);
  assert.equal(ACTIONS_BY_ID.move.terminal, true);
  assert.equal(ACTIONS_BY_ID.trash.terminal, true);
  assert.equal(ACTIONS_BY_ID.deletePermanently.terminal, true);
});

test('actionsOf reads both the old single action and the list', () => {
  assert.deepEqual(actionsOf({ action: { type: 'trash' } }), [{ type: 'trash' }]);
  assert.deepEqual(actionsOf({ actions: [{ type: 'markRead' }] }), [{ type: 'markRead' }]);
  // The list wins when a migrated rule somehow still carries both.
  assert.deepEqual(actionsOf({ action: { type: 'trash' }, actions: [{ type: 'markRead' }] }), [
    { type: 'markRead' },
  ]);
  assert.deepEqual(actionsOf({}), []);
});

test('a rule with no action throws rather than scanning for nothing', async () => {
  const m = fakeMessenger();
  await assert.rejects(() => runActions(m, [1], []), /no action/);
});

test('runActions on an empty id list does nothing', async () => {
  const m = fakeMessenger();
  await runActions(m, [], [{ type: 'trash' }]);
  assert.equal(m.calls.length, 0);
});
