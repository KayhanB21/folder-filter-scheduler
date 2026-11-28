/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  ACTIONS_BY_ID,
  BATCH_SIZE,
  UPDATE_BATCH_SIZE,
  actionsOf,
  orderActions,
  runAction,
  runActions,
} from '../src/actions.js';

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
      archive: rec('archive'),
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

test('archive hands the ids to messages.archive and ends the rule', async () => {
  const m = fakeMessenger();
  await runAction(m, [3, 4], { type: 'archive' });
  assert.deepEqual(m.calls, [{ name: 'archive', args: [[3, 4]] }]);
  assert.equal(ACTIONS_BY_ID.archive.terminal, true);
});

test('a tag action runs before archive, whatever the row order', async () => {
  const m = fakeMessenger({ 1: [] });
  await runActions(m, [1], [{ type: 'archive' }, { type: 'tag', tagKey: '$label1' }]);
  assert.deepEqual(
    m.calls.map((c) => c.name),
    ['update', 'archive'],
  );
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

test('each mark action sets its own state, on or off', async () => {
  const expected = {
    markRead: { read: true },
    markUnread: { read: false },
    markFlagged: { flagged: true },
    markUnflagged: { flagged: false },
    markJunk: { junk: true },
    markNotJunk: { junk: false },
  };
  for (const [type, change] of Object.entries(expected)) {
    const m = fakeMessenger();
    await runAction(m, [7], { type });
    assert.deepEqual(m.calls, [{ name: 'update', args: [7, change] }], type);
  }
});

test('a large archive goes to Thunderbird in batches, one after another', async () => {
  const ids = Array.from({ length: 2609 }, (_, i) => i + 1);
  let running = 0;
  let overlapped = false;
  const sizes = [];
  const m = {
    messages: {
      archive: async (batch) => {
        if (running > 0) overlapped = true;
        running += 1;
        sizes.push(batch.length);
        await new Promise((resolve) => setTimeout(resolve, 0));
        running -= 1;
      },
    },
  };
  await runAction(m, ids, { type: 'archive' });
  assert.equal(sizes.length, Math.ceil(2609 / BATCH_SIZE));
  assert.ok(sizes.every((n) => n <= BATCH_SIZE));
  assert.equal(sizes.reduce((a, b) => a + b, 0), 2609);
  assert.equal(overlapped, false);
});

test('move, copy, trash, and permanent delete are batched too', async () => {
  const ids = Array.from({ length: BATCH_SIZE + 1 }, (_, i) => i + 1);
  for (const [type, name, extra] of [
    ['move', 'move', { folderId: 'f' }],
    ['copy', 'copy', { folderId: 'f' }],
    ['trash', 'delete', {}],
    ['deletePermanently', 'delete', {}],
  ]) {
    const m = fakeMessenger();
    await runAction(m, ids, { type, ...extra });
    assert.deepEqual(m.calls.map((c) => [c.name, c.args[0].length]), [[name, BATCH_SIZE], [name, 1]], type);
  }
});

test('a failed batch stops the action, so the rule reports the error', async () => {
  const ids = Array.from({ length: BATCH_SIZE * 3 }, (_, i) => i + 1);
  let calls = 0;
  const m = {
    messages: {
      archive: async () => {
        calls += 1;
        if (calls === 2) throw new Error('Can only have one MessageArchiver running at once');
      },
    },
  };
  await assert.rejects(runAction(m, ids, { type: 'archive' }), /MessageArchiver/);
  assert.equal(calls, 2);
});

test('a batched action reports each group, and a small one reports nothing', async () => {
  const progress = [];
  const onProgress = (action, done, total) => progress.push([action.type, done, total]);
  const tag = { type: 'tag', tagKey: '$label1' };
  await runActions(fakeMessenger(), [1, 2], [tag, { type: 'archive' }], onProgress);
  assert.deepEqual(progress, []);

  const ids = Array.from({ length: BATCH_SIZE * 2 + 9 }, (_, i) => i + 1);
  await runActions(fakeMessenger(), ids, [tag, { type: 'archive' }], onProgress);
  assert.deepEqual(progress, [
    ['tag', BATCH_SIZE, ids.length],
    ['tag', BATCH_SIZE * 2, ids.length],
    ['tag', ids.length, ids.length],
    ['archive', BATCH_SIZE, ids.length],
    ['archive', BATCH_SIZE * 2, ids.length],
    ['archive', ids.length, ids.length],
  ]);
});

test('tag and mark actions throttle concurrent updates to UPDATE_BATCH_SIZE', async () => {
  const count = BATCH_SIZE + 37;
  const ids = Array.from({ length: count }, (_, i) => i + 1);

  for (const action of [
    { type: 'tag', tagKey: '$label1' },
    { type: 'markRead' },
    { type: 'markFlagged' },
    { type: 'markJunk' },
  ]) {
    let inFlight = 0;
    let maxInFlight = 0;
    let updates = 0;
    const m = {
      messages: {
        get: async (id) => ({ id, tags: [] }),
        update: async () => {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          await new Promise((resolve) => setTimeout(resolve, 0));
          inFlight -= 1;
          updates += 1;
        },
      },
    };
    const progress = [];
    const acted = await runAction(m, ids, action, (done, total) => progress.push([done, total]));
    assert.equal(updates, count, action.type);
    assert.equal(acted.length, count, action.type);
    assert.ok(maxInFlight > 1, `${action.type} should batch concurrently`);
    assert.ok(maxInFlight <= UPDATE_BATCH_SIZE, `${action.type} exceeded cap: ${maxInFlight}`);
    assert.deepEqual(progress, [[BATCH_SIZE, count], [count, count]], action.type);
  }
});

test('a failure in an update wave stops subsequent waves', async () => {
  const ids = Array.from({ length: UPDATE_BATCH_SIZE * 3 }, (_, i) => i + 1);
  let calls = 0;
  const m = {
    messages: {
      update: async (id) => {
        calls += 1;
        if (id === UPDATE_BATCH_SIZE + 1) throw new Error('update failed');
      },
    },
  };
  await assert.rejects(runAction(m, ids, { type: 'markRead' }), /update failed/);
  assert.equal(calls, UPDATE_BATCH_SIZE * 2);
});

test('tag reuses scanned headers, skips messages already tagged, and composes two tag actions', async () => {
  const calls = [];
  let gets = 0;
  const m = {
    messages: {
      get: async (id) => {
        gets += 1;
        return { id, tags: [] };
      },
      update: async (id, props) => {
        calls.push([id, props]);
      },
    },
  };
  const h1 = { id: 1, tags: ['$label1'] };
  const h2 = { id: 2, tags: ['$label3'] };
  const headers = new Map([[1, h1], [2, h2]]);

  const result = await runActions(
    m,
    [1, 2],
    [
      { type: 'tag', tagKey: '$label1' },
      { type: 'tag', tagKey: '$label2' },
    ],
    { headers },
  );

  assert.equal(gets, 0);
  assert.deepEqual(calls, [
    [2, { tags: ['$label3', '$label1'] }],
    [1, { tags: ['$label1', '$label2'] }],
    [2, { tags: ['$label3', '$label1', '$label2'] }],
  ]);
  assert.equal(result.affected, 2);
  // Original headers were not mutated.
  assert.deepEqual(h1.tags, ['$label1']);
  assert.deepEqual(h2.tags, ['$label3']);
});

test('mark actions skip messages already in the desired state while terminal actions still run', async () => {
  const m = fakeMessenger();
  const headers = new Map([
    [1, { id: 1, read: true, flagged: false, junk: false, tags: [] }],
    [2, { id: 2, read: false, flagged: true, junk: true, tags: [] }],
  ]);

  // Mark-only rule: only message 2 was unread, so only message 2 is updated and counted as affected.
  const markOnly = await runActions(m, [1, 2], [{ type: 'markRead' }], { headers });
  assert.deepEqual(m.calls, [{ name: 'update', args: [2, { read: true }] }]);
  assert.equal(markOnly.affected, 1);

  // Mark + Move: message 1 skips redundant markRead, but both messages are moved.
  const m2 = fakeMessenger();
  const combined = await runActions(
    m2,
    [1, 2],
    [{ type: 'markRead' }, { type: 'move', folderId: 'dest' }],
    { headers },
  );
  assert.deepEqual(m2.calls, [
    { name: 'update', args: [2, { read: true }] },
    { name: 'move', args: [[1, 2], 'dest'] },
  ]);
  assert.equal(combined.affected, 2);
});

test('tag falls back to messages.get when a scanned header has no tags array', async () => {
  const m = fakeMessenger({ 1: ['$label3'] });
  const headers = new Map([[1, { id: 1 }]]);
  const acted = await runAction(m, [1], { type: 'tag', tagKey: '$label1' }, { headers });
  assert.deepEqual(acted, [1]);
  assert.deepEqual(m.calls, [{ name: 'update', args: [1, { tags: ['$label3', '$label1'] }] }]);
});

test('copy honours filterIds and reports each completed batch via onBatch', async () => {
  const ids = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => i + 1);
  const completedBatches = [];
  let copyCalls = 0;
  const m = {
    messages: {
      copy: async (batch) => {
        copyCalls += 1;
        if (copyCalls === 2) throw new Error('IMAP copy failed');
      },
    },
  };

  await assert.rejects(
    runActions(m, ids, [{ type: 'copy', folderId: 'dest' }], {
      filterIds: (action, candidates) => (action.type === 'copy' ? candidates.slice(1) : candidates),
      onBatch: (action, batch) => completedBatches.push([action.type, batch.length, batch[0]]),
    }),
    /IMAP copy failed/,
  );

  // Batch 1 succeeded and was reported to onBatch before batch 2 threw; id 1 was filtered out.
  assert.deepEqual(completedBatches, [['copy', BATCH_SIZE, 2]]);
});

test('when copy filters out every message, a companion move still runs and counts as affected', async () => {
  const m = fakeMessenger();
  const result = await runActions(
    m,
    [1, 2],
    [{ type: 'copy', folderId: 'backup' }, { type: 'move', folderId: 'archive' }],
    { filterIds: (action, ids) => (action.type === 'copy' ? [] : ids) },
  );
  assert.deepEqual(m.calls, [{ name: 'move', args: [[1, 2], 'archive'] }]);
  assert.equal(result.affected, 2);
});
