/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_TTL_MS,
  QUICK_ATTEMPTS,
  RETRY_WINDOW_MS,
  SLOW_RETRY_MS,
  cacheKeyOf,
  isPending,
  needsCheck,
  pruneCache,
  quickRetryDelay,
  recordCheck,
  settingsKeyOf,
} from '../../src/auth/cache.js';

const header = {
  headerMessageId: 'abc@example.com',
  author: 'A <a@example.com>',
  date: new Date('2026-10-22T12:44:28Z'),
  size: 1234,
};
const settingsKey = settingsKeyOf({ ownState: 'on', trustedServers: [] });
const ok = { provider: { spf: 'pass' }, own: { dkim: 'pass', dmarc: 'pass' }, retry: false };
const failed = { provider: { spf: 'pass' }, own: { dkim: 'temp', dmarc: 'temp' }, retry: true };
const T0 = 1_800_000_000_000;

test('the key is a SHA-256 of the indexed values, and changes with any of them', async () => {
  const key = await cacheKeyOf(header);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(await cacheKeyOf({ ...header }), key);
  for (const change of [{ headerMessageId: 'x@example.com' }, { author: 'B' }, { date: new Date(0) }, { size: 1 }]) {
    assert.notEqual(await cacheKeyOf({ ...header, ...change }), key, JSON.stringify(change));
  }
});

test('a message without a Message-ID has no key', async () => {
  assert.equal(await cacheKeyOf({ ...header, headerMessageId: '' }), null);
  assert.equal(await cacheKeyOf({ ...header, headerMessageId: undefined }), null);
});

test('the settings key ignores the order of trusted servers', () => {
  assert.equal(
    settingsKeyOf({ ownState: 'on', trustedServers: ['b', 'a'] }),
    settingsKeyOf({ ownState: 'on', trustedServers: ['a', 'b'] }),
  );
  assert.notEqual(settingsKeyOf({ ownState: 'on' }), settingsKeyOf({ ownState: 'off' }));
});

test('a check that succeeds is kept until it expires or the settings change', () => {
  const entry = recordCheck(undefined, ok, { settingsKey, now: T0 });
  assert.equal(entry.retry, false);
  assert.equal(needsCheck(undefined, { settingsKey, now: T0 }), true);
  assert.equal(needsCheck(entry, { settingsKey, now: T0 + 1000 }), false);
  assert.equal(needsCheck(entry, { settingsKey: 'other', now: T0 + 1000 }), true);
  assert.equal(needsCheck(entry, { settingsKey, now: T0 + CACHE_TTL_MS + 1 }), true);
  assert.equal(isPending(entry, T0), false);
});

test('a failure is retried 3 times quickly, then every 30 minutes for 24 hours', () => {
  let entry = recordCheck(undefined, failed, { settingsKey, now: T0 });
  assert.equal(entry.attempts, 1);
  assert.equal(quickRetryDelay(entry), 20_000);
  assert.equal(needsCheck(entry, { settingsKey, now: T0 + 1 }), true);

  entry = recordCheck(entry, failed, { settingsKey, now: T0 + 20_000 });
  assert.equal(entry.attempts, 2);
  assert.equal(quickRetryDelay(entry), 40_000);

  entry = recordCheck(entry, failed, { settingsKey, now: T0 + 60_000 });
  assert.equal(entry.attempts, QUICK_ATTEMPTS);
  assert.equal(quickRetryDelay(entry), null);
  assert.equal(entry.firstFailAt, T0);
  assert.equal(entry.retryUntil, T0 + RETRY_WINDOW_MS);

  // After the quick retries, only once the catch-up interval has passed.
  assert.equal(needsCheck(entry, { settingsKey, now: T0 + 60_000 + SLOW_RETRY_MS - 1 }), false);
  assert.equal(needsCheck(entry, { settingsKey, now: T0 + 60_000 + SLOW_RETRY_MS }), true);
  assert.equal(isPending(entry, T0 + 60_000), true);

  // After 24 hours it stops and keeps the failure.
  assert.equal(isPending(entry, T0 + RETRY_WINDOW_MS), false);
  assert.equal(needsCheck(entry, { settingsKey, now: T0 + RETRY_WINDOW_MS }), false);
});

test('a success after a failure ends the retries', () => {
  const first = recordCheck(undefined, failed, { settingsKey, now: T0 });
  const entry = recordCheck(first, ok, { settingsKey, now: T0 + 20_000 });
  assert.equal(entry.retry, false);
  assert.equal(entry.attempts, undefined);
  assert.deepEqual(entry.own, ok.own);
});

test('a download timeout keeps the provider result an earlier attempt found', () => {
  const first = recordCheck(undefined, failed, { settingsKey, now: T0 });
  const entry = recordCheck(first, { provider: null, own: null, retry: true }, { settingsKey, now: T0 + 20_000 });
  assert.deepEqual(entry.provider, failed.provider);
  assert.equal(entry.attempts, 2);
});

test('the attempt count restarts under other settings', () => {
  const first = recordCheck(undefined, failed, { settingsKey: 'old', now: T0 });
  const entry = recordCheck(first, failed, { settingsKey, now: T0 + 1000 });
  assert.equal(entry.attempts, 1);
  assert.equal(entry.firstFailAt, T0 + 1000);
});

test('pruning drops expired entries and keeps the newest within the cap', () => {
  const cache = {
    old: { checkedAt: T0 - CACHE_TTL_MS - 1 },
    a: { checkedAt: T0 - 3 },
    b: { checkedAt: T0 - 1 },
    c: { checkedAt: T0 - 2 },
  };
  assert.deepEqual(Object.keys(pruneCache(cache, T0, 2)).sort(), ['b', 'c']);
  assert.deepEqual(Object.keys(pruneCache(cache, T0)).sort(), ['a', 'b', 'c']);
  assert.ok('old' in cache, 'never mutates');
});
