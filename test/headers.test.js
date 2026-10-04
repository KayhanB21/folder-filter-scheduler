/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeaderReads } from '../src/headers.js';

const never = () => new Promise(() => {});
const answers = (headers) => async () => ({ headers });
const HEADERS = { 'reply-to': ['a@evil.example'] };

/** A reader with a short limit, plus what it called and logged. */
function setup({ getHeaders, getFull, limit = 2 }) {
  const calls = [];
  const logged = [];
  const wrap = (name, fn) => fn && ((id) => {
    calls.push(`${name}:${id}`);
    return fn(id);
  });
  const reads = createHeaderReads({
    getHeaders: wrap('headers', getHeaders),
    getFull: wrap('full', getFull),
    timeoutMs: 20,
    limit,
    onTimeout: (message) => logged.push(message),
  });
  return { reads, calls, logged };
}

test('a working getHeaders is the only call made', async () => {
  const { reads, calls, logged } = setup({ getHeaders: answers(HEADERS), getFull: answers({}) });
  assert.deepEqual(await reads.read(1, 'acct'), HEADERS);
  assert.deepEqual(calls, ['headers:1']);
  assert.deepEqual(logged, []);
  assert.equal(reads.timeouts, 0);
  assert.equal(reads.skipped, 0);
});

test('a getHeaders that never answers falls back to getFull on the same message', async () => {
  const { reads, calls, logged } = setup({ getHeaders: never, getFull: answers(HEADERS) });
  assert.deepEqual(await reads.read(1, 'acct'), HEADERS);
  assert.deepEqual(calls, ['headers:1', 'full:1']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /no answer after 0\.02 s, reading whole messages on this account/);
  // The wait was made good, so it does not count toward the limit.
  assert.equal(reads.timeouts, 0);
  assert.equal(reads.skipped, 0);
});

test('the account stays on getFull for the rest of the run', async () => {
  const { reads, calls } = setup({ getHeaders: never, getFull: answers(HEADERS) });
  await reads.read(1, 'acct');
  for (const id of [2, 3, 4]) assert.deepEqual(await reads.read(id, 'acct'), HEADERS);
  assert.deepEqual(calls, ['headers:1', 'full:1', 'full:2', 'full:3', 'full:4']);
  assert.equal(reads.stopped, false);
});

test('another account still starts with getHeaders', async () => {
  const getHeaders = (id) => (id < 10 ? never() : answers(HEADERS)());
  const { reads, calls } = setup({ getHeaders, getFull: answers(HEADERS) });
  await reads.read(1, 'slow');
  await reads.read(10, 'fast');
  await reads.read(2, 'slow');
  assert.deepEqual(calls, ['headers:1', 'full:1', 'headers:10', 'full:2']);
});

test('when both calls give no answer, the message is skipped and the run stops reading', async () => {
  const { reads, calls, logged } = setup({ getHeaders: never, getFull: never });
  assert.equal(await reads.read(1, 'acct'), null);
  assert.equal(reads.timeouts, 2);
  assert.equal(reads.skipped, 1);
  assert.equal(reads.stopped, true);
  assert.match(logged[1], /2 reads gave no answer, no more header reads this run/);

  // No further call is made: each one would wait out the limit again.
  assert.equal(await reads.read(2, 'acct'), null);
  assert.equal(await reads.read(3, 'other'), null);
  assert.deepEqual(calls, ['headers:1', 'full:1']);
  assert.equal(reads.skipped, 3);
});

test('a getFull timeout on its own skips one message and reading goes on', async () => {
  const getFull = (id) => (id === 2 ? never() : answers(HEADERS)());
  const { reads } = setup({ getHeaders: never, getFull });
  assert.deepEqual(await reads.read(1, 'acct'), HEADERS);
  assert.equal(await reads.read(2, 'acct'), null);
  assert.equal(reads.timeouts, 1);
  assert.equal(reads.stopped, false);
  assert.deepEqual(await reads.read(3, 'acct'), HEADERS);
});

test('without getHeaders, every read uses getFull', async () => {
  const { reads, calls } = setup({ getFull: answers(HEADERS) });
  assert.deepEqual(await reads.read(1), HEADERS);
  assert.deepEqual(calls, ['full:1']);
});

test('an error that is not a timeout reaches the caller, and no fallback follows', async () => {
  const offline = async () => {
    throw new Error('offline');
  };
  const { reads, calls } = setup({ getHeaders: offline, getFull: answers(HEADERS) });
  await assert.rejects(reads.read(1, 'acct'), /offline/);
  assert.deepEqual(calls, ['headers:1']);
  assert.equal(reads.timeouts, 0);

  const second = setup({ getHeaders: never, getFull: offline });
  await assert.rejects(second.reads.read(1, 'acct'), /offline/);
});

test('a result with no headers part is read as the headers themselves', async () => {
  const { reads } = setup({ getHeaders: async () => HEADERS, getFull: answers({}) });
  assert.deepEqual(await reads.read(1), HEADERS);
  const empty = setup({ getHeaders: async () => undefined, getFull: answers({}) });
  assert.deepEqual(await empty.reads.read(1), {});
});
