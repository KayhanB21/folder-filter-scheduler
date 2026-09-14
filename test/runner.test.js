/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from '../src/runner.js';

/** A run that finishes only when the test says so, recording how it was called. */
function controllable() {
  const calls = [];
  let release;
  const run = (reason, context) => {
    calls.push({ reason, folderIds: context?.folderIds ? [...context.folderIds].sort() : null });
    return new Promise((resolve, reject) => {
      release = { resolve, reject };
    });
  };
  return { calls, run, finish: (v = 0) => release.resolve(v), fail: (e) => release.reject(e) };
}

test('a run starts immediately when nothing is in flight', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const promise = runner.request('scheduled');
  assert.deepEqual(c.calls, [{ reason: 'scheduled', folderIds: null }]);
  assert.equal(runner.isRunning(), true);
  c.finish(3);
  assert.equal(await promise, 3);
  assert.equal(runner.isRunning(), false);
});

test('triggers during a run collapse into exactly one follow-up', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const first = runner.request('scheduled');

  // A burst of new mail while the scheduled run is still going.
  const a = runner.request('newMail', { folderIds: new Set(['junk']) });
  const b = runner.request('newMail', { folderIds: new Set(['bulk']) });
  const d = runner.request('newMail', { folderIds: new Set(['junk']) });
  assert.equal(c.calls.length, 1, 'nothing else may start while a run is in flight');

  c.finish(1);
  await first;
  // One follow-up, covering the union of every folder seen meanwhile.
  assert.deepEqual(c.calls[1], { reason: 'newMail', folderIds: ['bulk', 'junk'] });
  c.finish(2);
  assert.deepEqual(await Promise.all([a, b, d]), [2, 2, 2]);
  assert.equal(c.calls.length, 2);
});

test('a manual request upgrades the queued run and drops its folder scope', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const first = runner.request('scheduled');
  runner.request('newMail', { folderIds: new Set(['junk']) });
  const manual = runner.request('manual');

  c.finish(0);
  await first;
  // "Run all rules now" means every rule and every folder, never the narrower
  // pass that happened to be queued.
  assert.deepEqual(c.calls[1], { reason: 'manual', folderIds: null });
  c.finish(9);
  assert.equal(await manual, 9);
});

test('an unscoped trigger widens a queued scoped one', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const first = runner.request('scheduled');
  runner.request('newMail', { folderIds: new Set(['junk']) });
  runner.request('scheduled');

  c.finish(0);
  await first;
  assert.equal(c.calls[1].folderIds, null);
  c.finish(0);
});

test('a failed run does not wedge the gate, and the queued run still happens', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const first = runner.request('scheduled');
  const queued = runner.request('newMail', { folderIds: new Set(['junk']) });

  c.fail(new Error('scan exploded'));
  await assert.rejects(() => first, /scan exploded/);
  assert.equal(c.calls.length, 2, 'the queued run must still start');
  c.finish(4);
  assert.equal(await queued, 4);
  assert.equal(runner.isRunning(), false);

  // And the gate is usable again afterwards.
  const third = runner.request('scheduled');
  c.finish(0);
  await third;
  assert.equal(c.calls.length, 3);
});

test('a rejection reaches the caller that queued it, not the one before', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const first = runner.request('scheduled');
  const queued = runner.request('newMail', { folderIds: new Set(['junk']) });
  c.finish(1);
  assert.equal(await first, 1);
  c.fail(new Error('second boom'));
  await assert.rejects(() => queued, /second boom/);
});

test('a run throwing synchronously is still handled as a rejection', async () => {
  const runner = createRunner(() => {
    throw new Error('sync boom');
  });
  await assert.rejects(() => runner.request('scheduled'), /sync boom/);
  assert.equal(runner.isRunning(), false);
});
