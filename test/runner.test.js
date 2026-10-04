/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, withTimeout } from '../src/runner.js';

/** A run that finishes only when the test says so, recording how it was called. */
function controllable() {
  const calls = [];
  const contexts = [];
  let release;
  const run = (reason, context) => {
    calls.push({ reason, folderIds: context?.folderIds ? [...context.folderIds].sort() : null });
    contexts.push(context);
    return new Promise((resolve, reject) => {
      release = { resolve, reject };
    });
  };
  return { calls, contexts, run, finish: (v = 0) => release.resolve(v), fail: (e) => release.reject(e) };
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

test('withTimeout passes a value through when the promise settles in time', async () => {
  assert.equal(await withTimeout(Promise.resolve('headers'), 50), 'headers');
});

test('withTimeout passes a rejection through unchanged', async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error('offline')), 50), /offline/);
});

test('withTimeout rejects with a TimeoutError when the promise never settles', async () => {
  await assert.rejects(withTimeout(new Promise(() => {}), 5), { name: 'TimeoutError' });
});

const ids = (set) => (set ? [...set].sort() : null);

test('a manual request for one rule runs only that rule', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const promise = runner.request('manual', { ruleIds: new Set(['banks']) });

  assert.equal(c.calls[0].reason, 'manual');
  assert.deepEqual(ids(c.contexts[0].ruleIds), ['banks']);
  assert.equal(c.contexts[0].background, false);
  c.finish(2);
  assert.equal(await promise, 2);
});

test('queued manual requests for two rules run both, and no others', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const first = runner.request('scheduled');
  runner.request('manual', { ruleIds: new Set(['banks']) });
  runner.request('manual', { ruleIds: new Set(['spam']) });

  c.finish(0);
  await first;
  assert.deepEqual(ids(c.contexts[1].ruleIds), ['banks', 'spam']);
  assert.equal(c.contexts[1].background, false);
  c.finish(0);
});

test('a new-mail trigger joining a one-rule manual run keeps both scopes', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const first = runner.request('scheduled');
  runner.request('manual', { ruleIds: new Set(['banks']) });
  runner.request('newMail', { folderIds: new Set(['junk']) });

  c.finish(0);
  await first;
  // The full scan stays on the one rule; the rest get the new-mail pass.
  assert.equal(c.calls[1].reason, 'manual');
  assert.deepEqual(ids(c.contexts[1].ruleIds), ['banks']);
  assert.deepEqual(c.calls[1].folderIds, ['junk']);
  assert.equal(c.contexts[1].background, true);
  c.finish(0);
});

test('a one-rule manual request joining a queued new-mail run keeps the folder scope', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const first = runner.request('scheduled');
  runner.request('newMail', { folderIds: new Set(['junk']) });
  runner.request('manual', { ruleIds: new Set(['banks']) });

  c.finish(0);
  await first;
  assert.equal(c.calls[1].reason, 'manual');
  assert.deepEqual(ids(c.contexts[1].ruleIds), ['banks']);
  assert.deepEqual(c.calls[1].folderIds, ['junk']);
  assert.equal(c.contexts[1].background, true);
  c.finish(0);
});

test('"run all rules" overrides a queued one-rule request', async () => {
  const c = controllable();
  const runner = createRunner(c.run);
  const first = runner.request('scheduled');
  runner.request('manual', { ruleIds: new Set(['banks']) });
  runner.request('newMail', { folderIds: new Set(['junk']) });
  runner.request('manual');

  c.finish(0);
  await first;
  assert.equal(c.contexts[1].ruleIds, null);
  assert.equal(c.contexts[1].folderIds, null);
  c.finish(0);
});
