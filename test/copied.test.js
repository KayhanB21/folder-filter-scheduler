/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPY_BUCKET_PREFIX,
  COPY_CAP_PER_TARGET,
  COPY_HISTORY_KEY,
  COPY_OVERFLOW_KEY,
  copyBucketKey,
  copyKeyOf,
  createCopyHistory,
  hasCopyAction,
  loadStoredCopyHistory,
  parseCopyBucketKey,
  pruneCopyHistory,
} from '../src/copied.js';

const header = (overrides = {}) => ({
  id: 1,
  headerMessageId: '<msg-1@bank.example>',
  author: 'billing@bank.example',
  date: new Date('2026-11-20T10:00:00Z'),
  size: 4096,
  subject: 'Receipt #100',
  folder: { id: 'acct1:/Inbox' },
  ...overrides,
});

const copyRule = (id, folderIds = ['acct1:/Receipts'], extra = {}) => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  actions: folderIds.map((folderId) => ({ type: 'copy', folderId })),
  ...extra,
});

test('hasCopyAction detects rules with a usable copy action across old and new shapes', () => {
  assert.equal(hasCopyAction(copyRule('r1')), true);
  assert.equal(hasCopyAction({ id: 'r1', action: { type: 'copy', folderId: 'dest' } }), true);
  assert.equal(hasCopyAction({ id: 'r1', actions: [{ type: 'copy' }] }), false);
  assert.equal(hasCopyAction({ id: 'r1', actions: [{ type: 'move', folderId: 'dest' }] }), false);
  assert.equal(hasCopyAction({}), false);
});

test('copyKeyOf returns a stable 32-char hash and hides raw header values', async () => {
  const h = header();
  const k1 = await copyKeyOf(h);
  const k2 = await copyKeyOf(header({ id: 999, folder: { id: 'acct1:/AllMail' }, subject: 'Changed' }));
  assert.match(k1, /^[0-9a-f]{32}$/);
  // Same Message-ID/author/date/size in another folder (e.g. Gmail All Mail) produces the same key.
  assert.equal(k1, k2);
  // Changing any identifying field changes the key.
  assert.notEqual(k1, await copyKeyOf(header({ headerMessageId: '<msg-2@bank.example>' })));
  assert.notEqual(k1, await copyKeyOf(header({ size: 8192 })));
  assert.ok(!k1.includes('bank'));
});

test('copyKeyOf falls back cleanly when headerMessageId is missing', async () => {
  const a = await copyKeyOf(header({ headerMessageId: '', subject: 'One' }));
  const aAgain = await copyKeyOf(header({ id: 55, headerMessageId: '   ', subject: 'One' }));
  const b = await copyKeyOf(header({ headerMessageId: '', subject: 'Two' }));
  const otherFolder = await copyKeyOf(header({ headerMessageId: '', subject: 'One', folder: { id: 'acct1:/Other' } }));
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, aAgain);
  assert.notEqual(a, b);
  assert.notEqual(a, otherFolder);

  // Completely empty headers produce null rather than colliding on one blank key.
  assert.equal(await copyKeyOf({}), null);
  assert.equal(await copyKeyOf(null), null);
});

test('a copied message is skipped on later scans, while new messages are copied', async () => {
  const rules = [copyRule('r1', ['dest'])];
  const h1 = header({ id: 1, headerMessageId: '<a@example>' });
  const h2 = header({ id: 2, headerMessageId: '<b@example>' });
  const headers = new Map([[1, h1], [2, h2]]);

  let clock = 1000;
  const run1 = createCopyHistory({ stored: {}, rules, now: () => clock });
  assert.equal(run1.isDirty(), false);

  const first = await run1.filterUncopied('r1', 'dest', [1], headers);
  assert.deepEqual(first.toCopy, [1]);
  assert.deepEqual(first.skipped, []);
  run1.recordCopied('r1', 'dest', first.toCopy, first.keysById);
  assert.equal(run1.isDirty(), true);

  const saved = run1.finish();
  assert.ok(saved);

  // Simulated catch-up scan 30 minutes later sees message 1 again (even with a new numeric id) plus message 2.
  clock += 30 * 60_000;
  const h1Reindexed = header({ id: 101, headerMessageId: '<a@example>' });
  const run2 = createCopyHistory({ stored: saved, rules, now: () => clock });
  const second = await run2.filterUncopied('r1', 'dest', [101, 2], new Map([[101, h1Reindexed], [2, h2]]));
  assert.deepEqual(second.toCopy, [2]);
  assert.deepEqual(second.skipped, [101]);
});

test('changing or adding a copy destination copies there without re-copying to the first', async () => {
  const h1 = header({ id: 1, headerMessageId: '<a@example>' });
  const headers = new Map([[1, h1]]);

  const run1 = createCopyHistory({ stored: {}, rules: [copyRule('r1', ['destA'])] });
  const f1 = await run1.filterUncopied('r1', 'destA', [1], headers);
  run1.recordCopied('r1', 'destA', f1.toCopy, f1.keysById);
  const saved = run1.finish();

  // User adds destB alongside destA.
  const run2 = createCopyHistory({ stored: saved, rules: [copyRule('r1', ['destA', 'destB'])] });
  assert.deepEqual((await run2.filterUncopied('r1', 'destA', [1], headers)).toCopy, []);
  assert.deepEqual((await run2.filterUncopied('r1', 'destB', [1], headers)).toCopy, [1]);

  // User replaces destA with destC: destA history is pruned and destC copies fresh.
  const run3 = createCopyHistory({ stored: saved, rules: [copyRule('r1', ['destC'])] });
  assert.equal(run3.isDirty(), true);
  assert.deepEqual((await run3.filterUncopied('r1', 'destC', [1], headers)).toCopy, [1]);
  assert.equal(run3.snapshot().r1?.destA, undefined);
});

test('identical messages inside the same batch are copied only once', async () => {
  const h1 = header({ id: 10, headerMessageId: '<dup@example>' });
  const h2 = header({ id: 11, headerMessageId: '<dup@example>' });
  const headers = new Map([[10, h1], [11, h2]]);

  const tracker = createCopyHistory({ stored: {}, rules: [copyRule('r1', ['dest'])] });
  const res = await tracker.filterUncopied('r1', 'dest', [10, 11], headers);
  assert.deepEqual(res.toCopy, [10]);
  assert.deepEqual(res.skipped, [11]);
});

test('a message with no usable key is still allowed through rather than silently dropped', async () => {
  const tracker = createCopyHistory({ stored: {}, rules: [copyRule('r1', ['dest'])] });
  const res = await tracker.filterUncopied('r1', 'dest', [7], new Map([[7, {}]]));
  assert.deepEqual(res.toCopy, [7]);
  assert.deepEqual(res.skipped, []);
  assert.equal(tracker.recordCopied('r1', 'dest', [7], res.keysById), false);
});

test('pruneCopyHistory drops deleted rules and old destinations, keeps disabled rules, and enforces cap', () => {
  const stored = {
    keepEnabled: {
      dest1: { k1: 100, k2: 300, k3: 200, bad: 'nope' },
      oldDest: { k9: 500 },
    },
    keepDisabled: {
      dest2: { k4: 400 },
    },
    deletedRule: {
      dest3: { k5: 500 },
    },
  };
  const rules = [
    copyRule('keepEnabled', ['dest1']),
    copyRule('keepDisabled', ['dest2'], { enabled: false }),
  ];

  const { history, changed } = pruneCopyHistory(stored, rules, 2);
  assert.equal(changed, true);
  assert.deepEqual(history, {
    keepEnabled: { dest1: { k2: 300, k3: 200 } },
    keepDisabled: { dest2: { k4: 400 } },
  });
  // Input is never mutated.
  assert.ok(stored.deletedRule);
  assert.ok(stored.keepEnabled.oldDest);
  assert.equal(COPY_CAP_PER_TARGET, 50_000);
});

test('markSaved prevents redundant writes and tracks later batches accurately', async () => {
  const rules = [copyRule('r1', ['dest'])];
  const h1 = header({ id: 1, headerMessageId: '<1@example>' });
  const h2 = header({ id: 2, headerMessageId: '<2@example>' });
  const headers = new Map([[1, h1], [2, h2]]);

  const tracker = createCopyHistory({ stored: {}, rules });
  const { toCopy, keysById } = await tracker.filterUncopied('r1', 'dest', [1, 2], headers);
  assert.deepEqual(toCopy, [1, 2]);

  // Batch 1 completes and is saved immediately.
  tracker.recordCopied('r1', 'dest', [1], keysById);
  assert.equal(tracker.isDirty(), true);
  const v1 = tracker.version;
  const snap1 = tracker.snapshot();
  tracker.markSaved(v1);
  assert.equal(tracker.isDirty(), false);
  assert.equal(tracker.finish(), null);

  // Batch 2 completes later: tracker becomes dirty again even though batch 1 was already saved.
  tracker.recordCopied('r1', 'dest', [2], keysById);
  assert.equal(tracker.isDirty(), true);
  const snap2 = tracker.finish();
  assert.equal(Object.keys(snap1.r1.dest).length, 1);
  assert.equal(Object.keys(snap2.r1.dest).length, 2);
});

test('sharded copyHistory keys round-trip, migrate legacy data, and write only dirty buckets', async () => {
  const key = copyBucketKey('rule:1', 'acct1://Archive/2026');
  assert.ok(key.startsWith(COPY_BUCKET_PREFIX));
  assert.deepEqual(parseCopyBucketKey(key), ['rule:1', 'acct1://Archive/2026']);
  assert.equal(parseCopyBucketKey('otherKey'), null);
  assert.equal(parseCopyBucketKey(`${COPY_BUCKET_PREFIX}nocolon`), null);

  const keyR2 = copyBucketKey('r2', 'dest2');
  const staleKey = copyBucketKey('deleted', 'oldDest');
  const loaded = loadStoredCopyHistory({
    [COPY_HISTORY_KEY]: { r1: { dest1: { kLegacy: 100 } } },
    [keyR2]: { kShard: 200 },
    [staleKey]: { kStale: 50 },
    unrelated: { a: 1 },
  });
  assert.equal(loaded.hasLegacy, true);
  assert.deepEqual(loaded.shardKeys.sort(), [keyR2, staleKey].sort());
  assert.deepEqual(loaded.stored, {
    r1: { dest1: { kLegacy: 100 } },
    r2: { dest2: { kShard: 200 } },
    deleted: { oldDest: { kStale: 50 } },
  });

  const rules = [copyRule('r1', ['dest1']), copyRule('r2', ['dest2'])];
  const tracker = createCopyHistory({ stored: loaded.stored, rules });

  // Migration patch with forceAll writes every live bucket and drops stale shard keys.
  const migration = tracker.shardedPatch(loaded.shardKeys, { forceAll: true });
  const keyR1 = copyBucketKey('r1', 'dest1');
  assert.deepEqual(Object.keys(migration.toSet).sort(), [keyR1, keyR2].sort());
  assert.deepEqual(migration.toRemove, [staleKey]);
  tracker.markSaved(tracker.version);
  assert.equal(tracker.pendingAdds, 0);

  // Copying for r1 marks only r1's bucket dirty; r2's shard is not rewritten.
  const h1 = header({ id: 1, headerMessageId: '<new@example>' });
  const { toCopy, keysById } = await tracker.filterUncopied('r1', 'dest1', [1], new Map([[1, h1]]));
  tracker.recordCopied('r1', 'dest1', toCopy, keysById);
  assert.equal(tracker.pendingAdds, 1);

  const delta = tracker.shardedPatch(migration.liveKeys);
  assert.deepEqual(Object.keys(delta.toSet), [keyR1]);
  assert.deepEqual(delta.toRemove, []);

  tracker.markSaved(tracker.version);
  assert.equal(tracker.pendingAdds, 0);
});

test('after a destination drops entries past cap, filterUncopied checks the destination folder for evicted messages', async () => {
  const rules = [copyRule('r1', ['dest'])];
  const h1 = header({ id: 1, headerMessageId: '<1@example>' });
  const h2 = header({ id: 2, headerMessageId: '<2@example>' });
  const h3 = header({ id: 3, headerMessageId: '<3@example>' });
  const h4 = header({ id: 4, headerMessageId: '<4@example>' });
  const headers = new Map([[1, h1], [2, h2], [3, h3], [4, h4]]);

  let clock = 1000;
  const overflows = [];
  const destQueries = [];
  const inDest = new Set();
  const checkDestination = async (folderId, hdr) => {
    destQueries.push([folderId, hdr.headerMessageId]);
    return inDest.has(hdr.headerMessageId);
  };

  const run1 = createCopyHistory({
    stored: {},
    rules,
    cap: 2,
    now: () => (clock += 10),
    onOverflow: (rId, dId) => overflows.push([rId, dId]),
  });

  // Copying up to cap (2 messages) never triggers overflow or destination lookups.
  const f1 = await run1.filterUncopied('r1', 'dest', [1, 2], headers, { checkDestination });
  assert.deepEqual(f1.toCopy, [1, 2]);
  assert.deepEqual(destQueries, []);
  run1.recordCopied('r1', 'dest', [1], f1.keysById);
  run1.recordCopied('r1', 'dest', [2], f1.keysById);
  inDest.add('<1@example>');
  inDest.add('<2@example>');
  assert.equal(run1.isOverflowed('r1', 'dest'), false);
  assert.deepEqual(overflows, []);

  // Copying a 3rd message drops message 1 from the cap-2 history and flips overflow mode once.
  const f2 = await run1.filterUncopied('r1', 'dest', [3], headers, { checkDestination });
  assert.deepEqual(f2.toCopy, [3]);
  run1.recordCopied('r1', 'dest', [3], f2.keysById);
  inDest.add('<3@example>');
  assert.equal(run1.isOverflowed('r1', 'dest'), true);
  assert.deepEqual(overflows, [['r1', 'dest']]);

  // Persist sharded state including overflow metadata, then reload on a new run.
  const patch = run1.shardedPatch([], { hadOverflow: false });
  const key = copyBucketKey('r1', 'dest');
  assert.deepEqual(patch.toSet[COPY_OVERFLOW_KEY], [key]);
  assert.equal(patch.hasOverflow, true);
  run1.markSaved(run1.version);

  const loaded = loadStoredCopyHistory(patch.toSet);
  assert.equal(loaded.hadOverflowKey, true);
  assert.deepEqual(loaded.overflowed, [key]);

  const run2 = createCopyHistory({
    stored: loaded.stored,
    overflowed: loaded.overflowed,
    rules,
    cap: 2,
    now: () => (clock += 10),
  });
  assert.equal(run2.isOverflowed('r1', 'dest'), true);

  // Run 2 scans [1 (evicted, still in dest), 2 (in history), 3 (in history), 4 (brand new)]:
  // - 2 and 3 hit the local hash bucket with NO destination query
  // - 1 misses local history, queries destination -> found -> skipped (no duplicate!)
  // - 4 misses local history, queries destination -> not found -> copied!
  const f3 = await run2.filterUncopied('r1', 'dest', [1, 2, 3, 4], headers, { checkDestination });
  assert.deepEqual(f3.toCopy, [4]);
  assert.deepEqual(f3.skipped, [1, 2, 3]);
  assert.deepEqual(destQueries, [
    ['dest', '<1@example>'],
    ['dest', '<4@example>'],
  ]);

  // Deleting the rule removes both the shard and the overflow key.
  const run3 = createCopyHistory({ stored: loaded.stored, overflowed: loaded.overflowed, rules: [] });
  const cleanup = run3.shardedPatch(loaded.shardKeys, { hadOverflow: loaded.hadOverflowKey });
  assert.deepEqual(cleanup.toSet, {});
  assert.deepEqual(cleanup.toRemove.sort(), [key, COPY_OVERFLOW_KEY].sort());
  assert.equal(cleanup.hasOverflow, false);
});
