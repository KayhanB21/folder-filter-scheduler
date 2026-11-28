/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeaderReads, readHeadersOrSkip } from '../src/headers.js';

const never = () => new Promise(() => {});
// `getFull` answers with a message part that holds the headers. `getHeaders`
// answers with the headers themselves.
const answers = (headers) => async () => ({ headers });
const plain = (headers) => async () => headers;
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
  const { reads, calls, logged } = setup({ getHeaders: plain(HEADERS), getFull: answers({}) });
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
  const getHeaders = (id) => (id < 10 ? never() : plain(HEADERS)());
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

test('a known account goes straight to getFull, with no wait and no log line', async () => {
  const calls = [];
  const logged = [];
  const reads = createHeaderReads({
    getHeaders: (id) => {
      calls.push(`headers:${id}`);
      return never();
    },
    getFull: (id) => {
      calls.push(`full:${id}`);
      return answers(HEADERS)();
    },
    timeoutMs: 20,
    limit: 2,
    onTimeout: (message) => logged.push(message),
    viaFull: ['slow'],
  });
  assert.deepEqual(await reads.read(1, 'slow'), HEADERS);
  assert.deepEqual(calls, ['full:1']);
  assert.deepEqual(logged, []);
  assert.equal(reads.timeouts, 0);
});

test('onSwitch hears about each account one time, and never about a missing id', async () => {
  const switched = [];
  const reads = createHeaderReads({
    getHeaders: never,
    getFull: answers(HEADERS),
    timeoutMs: 20,
    limit: 2,
    onSwitch: (accountId) => switched.push(accountId),
  });
  await reads.read(1, 'a');
  await reads.read(2, 'a');
  await reads.read(3, 'b');
  await reads.read(4);
  await reads.read(5, undefined);
  assert.deepEqual(switched, ['a', 'b']);
});

test('the caller\'s set of known accounts is copied, not shared', async () => {
  const known = new Set();
  const reads = createHeaderReads({
    getHeaders: never, getFull: answers(HEADERS), timeoutMs: 20, limit: 2, viaFull: known,
  });
  await reads.read(1, 'a');
  assert.equal(known.size, 0);
});

test('readHeadersOrSkip returns null and counts the message as skipped when a read throws', async () => {
  const errors = [];
  const { reads } = setup({
    getHeaders: async () => { throw new Error('IMAP connection reset'); },
    getFull: answers(HEADERS),
  });
  assert.equal(await readHeadersOrSkip(reads, 1, 'acct', (e) => errors.push(e.message)), null);
  assert.deepEqual(errors, ['IMAP connection reset']);
  assert.equal(reads.skipped, 1);
});

test('readHeadersOrSkip does not double-count skipped on a timeout', async () => {
  const errors = [];
  const { reads } = setup({ getHeaders: never, getFull: never });
  assert.equal(await readHeadersOrSkip(reads, 1, 'acct', (e) => errors.push(e)), null);
  assert.deepEqual(errors, []);
  assert.equal(reads.skipped, 1);
});

test('readHeadersOrSkip returns headers on success and skips once if fallback getFull throws', async () => {
  const ok = setup({ getHeaders: plain(HEADERS), getFull: answers({}) });
  assert.deepEqual(await readHeadersOrSkip(ok.reads, 1, 'acct'), HEADERS);
  assert.equal(ok.reads.skipped, 0);

  const errors = [];
  const fallbackThrows = setup({
    getHeaders: never,
    getFull: async () => { throw new Error('offline'); },
  });
  assert.equal(
    await readHeadersOrSkip(fallbackThrows.reads, 1, 'acct', (e) => errors.push(e.message)),
    null,
  );
  assert.deepEqual(errors, ['offline']);
  assert.equal(fallbackThrows.reads.skipped, 1);
});

test('header reads are cached per run across multiple rules', async () => {
  const { reads, calls } = setup({ getHeaders: plain(HEADERS), getFull: answers({}) });
  assert.deepEqual(await reads.read(42, 'acct'), HEADERS);
  assert.deepEqual(await reads.read(42, 'acct'), HEADERS);
  assert.deepEqual(await reads.read(42, 'acct'), HEADERS);
  assert.deepEqual(calls, ['headers:42']);
  assert.equal(reads.cached, 2);
});

test('a failed or timed-out message is remembered for the run without losing skipped counts', async () => {
  let attempts = 0;
  const { reads } = setup({
    getHeaders: async () => {
      attempts += 1;
      throw new Error('IMAP reset');
    },
    getFull: answers(HEADERS),
  });
  assert.equal(await readHeadersOrSkip(reads, 7, 'acct'), null);
  assert.equal(await readHeadersOrSkip(reads, 7, 'acct'), null);
  assert.equal(attempts, 1);
  assert.equal(reads.skipped, 2);
});

test('budgetMs stops fresh header downloads while still serving cached messages', async () => {
  let t = 0;
  const calls = [];
  const logged = [];
  const reads = createHeaderReads({
    getHeaders: async (id) => {
      calls.push(id);
      t += 12_000;
      return { 'x-id': [String(id)] };
    },
    getFull: answers({}),
    timeoutMs: 20,
    limit: 5,
    budgetMs: 20_000,
    now: () => t,
    onTimeout: (msg) => logged.push(msg),
  });

  assert.deepEqual(await reads.read(1, 'acct'), { 'x-id': ['1'] });
  assert.deepEqual(await reads.read(2, 'acct'), { 'x-id': ['2'] });
  // Elapsed is now 24s >= 20s: message 3 is deferred, but cached message 1 still succeeds.
  assert.equal(await reads.read(3, 'acct'), null);
  assert.equal(reads.stopped, true);
  assert.equal(reads.skipped, 1);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /20 s time budget/);
  assert.deepEqual(await reads.read(1, 'acct'), { 'x-id': ['1'] });
  assert.equal(await reads.read(4, 'acct'), null);
  assert.equal(reads.skipped, 2);
  assert.deepEqual(calls, [1, 2]);
});

test('budgetMs counts only time inside fresh reads, ignoring time spent on other rules', async () => {
  let t = 0;
  const reads = createHeaderReads({
    getHeaders: async (id) => {
      t += 100;
      return { 'x-id': [String(id)] };
    },
    getFull: answers({}),
    timeoutMs: 1000,
    limit: 5,
    budgetMs: 20_000,
    now: () => t,
  });

  // Simulate 30 s spent moving/archiving messages in earlier rules before any header read.
  t += 30_000;
  assert.deepEqual(await reads.read(1, 'acct'), { 'x-id': ['1'] });
  assert.equal(reads.spentMs, 100);
  assert.equal(reads.budgetReached, false);

  // Another 25 s spent between reads still does not eat into the read budget.
  t += 25_000;
  assert.deepEqual(await reads.read(2, 'acct'), { 'x-id': ['2'] });
  assert.equal(reads.spentMs, 200);
  assert.equal(reads.budgetReached, false);
});

test('a header call capped by remaining budget stops cleanly without switching the account to getFull', async () => {
  const switched = [];
  const calls = [];
  const logged = [];
  const reads = createHeaderReads({
    getHeaders: (id) => {
      calls.push(`headers:${id}`);
      return never();
    },
    getFull: (id) => {
      calls.push(`full:${id}`);
      return answers(HEADERS)();
    },
    timeoutMs: 80,
    limit: 2,
    budgetMs: 25,
    onSwitch: (acct) => switched.push(acct),
    onTimeout: (m) => logged.push(m),
  });

  assert.equal(await reads.read(1, 'acct'), null);
  assert.equal(reads.budgetReached, true);
  assert.equal(reads.stopped, true);
  assert.equal(reads.timeouts, 0);
  assert.deepEqual(switched, []);
  assert.deepEqual(calls, ['headers:1']);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /time budget/);
});

test('a header line named Headers does not replace the real headers', async () => {
  const sent = { 'list-id': ['<team.corp.example>'], headers: ['x'] };
  const { reads } = setup({ getHeaders: plain(sent), getFull: answers({}) });
  assert.deepEqual(await reads.read(1, 'acct'), sent);

  // The whole-message read returns a part: its `headers` property is the dictionary.
  const full = setup({ getHeaders: undefined, getFull: answers(sent) });
  assert.deepEqual(await full.reads.read(1, 'acct'), sent);
});
