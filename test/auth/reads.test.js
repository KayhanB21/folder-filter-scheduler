/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthReads } from '../../src/auth/reads.js';
import { OWN_BLOCKED, OWN_ON, PREFER_OWN } from '../../src/auth/check.js';
import { RFC_RECORDS, fakeDns, fixture } from './helpers.js';

const never = () => new Promise(() => {});
const header = (id, extra = {}) => ({
  id,
  headerMessageId: `m${id}@example.com`,
  author: 'Joe <joe@football.example.com>',
  date: new Date('2026-10-22T12:00:00Z'),
  size: 100 + id,
  ...extra,
});

/** Reads with a fake clock, a fake download, and a fake DNS server. */
function setup({ getRaw = async () => fixture('rfc6376-A.2.eml'), dns, ownState = OWN_ON, cache = {}, budgetMs = 20_000 } = {}) {
  let clock = 1_800_000_000_000;
  const downloads = [];
  const asked = [];
  const reads = createAuthReads({
    getRaw: (id) => {
      downloads.push(id);
      return getRaw(id);
    },
    queryFunction: dns ?? fakeDns({ ...RFC_RECORDS, '_dmarc.example.com': 'v=DMARC1; p=reject' }, { asked }),
    ownState,
    prefer: PREFER_OWN,
    trustedServers: [],
    cache,
    timeoutMs: 20,
    budgetMs,
    now: () => clock,
  });
  return { reads, downloads, asked, tick: (ms) => { clock += ms; } };
}

test('a message is downloaded once, then answered from the cache', async () => {
  const { reads, downloads } = setup();
  const first = await reads.read(header(1));
  assert.deepEqual(first, { auth: { spf: 'unknown', dkim: 'pass', dmarc: 'pass' }, pending: false });
  const { cache } = reads.finish();
  assert.equal(Object.keys(cache).length, 1);

  const again = setup({ cache });
  assert.deepEqual(await again.reads.read(header(1)), first);
  assert.deepEqual(again.downloads, []);
  assert.equal(again.reads.counts.cached, 1);
  assert.equal(again.reads.finish().cache, null, 'nothing new to save');
});

test('each DNS query goes out once per run', async () => {
  const { reads, asked } = setup();
  await reads.read(header(1));
  await reads.read(header(2));
  assert.deepEqual(asked, ['brisbane._domainkey.example.com', '_dmarc.football.example.com', '_dmarc.example.com']);
});

test('a download that times out is pending and asks for a quick retry', async () => {
  const { reads } = setup({ getRaw: never });
  const result = await reads.read(header(1));
  assert.deepEqual(result, { auth: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' }, pending: true });
  assert.equal(reads.counts.failed, 1);
  const { cache, retryDelayMs } = reads.finish();
  assert.equal(retryDelayMs, 20_000);
  assert.equal(Object.values(cache)[0].attempts, 1);
});

test('a DNS error is pending; a later run that succeeds settles it', async () => {
  const failing = setup({ dns: fakeDns({}, { fail: ['brisbane._domainkey.example.com'] }) });
  assert.equal((await failing.reads.read(header(1))).pending, true);
  const { cache } = failing.reads.finish();

  const later = setup({ cache });
  const result = await later.reads.read(header(1));
  assert.deepEqual(result, { auth: { spf: 'unknown', dkim: 'pass', dmarc: 'pass' }, pending: false });
});

test('after 24 hours of failures the message stays unknown and is no longer pending', async () => {
  let cache = {};
  let run;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    run = setup({ getRaw: never, cache });
    await run.reads.read(header(1));
    cache = run.reads.finish().cache;
  }
  const entry = Object.values(cache)[0];
  assert.equal(entry.attempts, 3);

  const late = setup({ getRaw: never, cache });
  late.tick(24 * 60 * 60 * 1000);
  const result = await late.reads.read(header(1));
  assert.deepEqual(result, { auth: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' }, pending: false });
  assert.deepEqual(late.downloads, []);
  assert.equal(late.reads.counts.unchecked, 1);
});

test('a message without a Message-ID is checked but never held for a retry', async () => {
  const { reads } = setup({ getRaw: never });
  const result = await reads.read(header(1, { headerMessageId: '' }));
  assert.equal(result.pending, false);
  assert.equal(reads.finish().cache, null);
});

test('after the time budget, messages wait for the next run without a failed attempt', async () => {
  const { reads, downloads, tick } = setup({ budgetMs: 1000 });
  await reads.read(header(1));
  tick(1000);
  const result = await reads.read(header(2));
  assert.equal(result.pending, true);
  assert.deepEqual(downloads, [1]);
  assert.equal(reads.counts.deferred, 1);
  assert.equal(reads.counts.failed, 0);
  assert.equal(reads.finish().retryDelayMs, 20_000, 'the next run continues soon');
});

test('with the own check blocked, nothing is asked of DNS', async () => {
  const { reads, asked } = setup({ ownState: OWN_BLOCKED });
  const result = await reads.read(header(1));
  assert.deepEqual(result, { auth: { spf: 'unknown', dkim: 'unknown', dmarc: 'unknown' }, pending: false });
  assert.deepEqual(asked, []);
});

test('each method counts its results once per message', async () => {
  const { reads } = setup();
  await reads.read(header(1));
  await reads.read(header(1));
  assert.deepEqual(reads.counts.results, {
    spf: { pass: 0, notPass: 0, unknown: 1 },
    dkim: { pass: 1, notPass: 0, unknown: 0 },
    dmarc: { pass: 1, notPass: 0, unknown: 0 },
  });
});
