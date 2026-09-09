/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATCH_UP_EVERY_MINUTES,
  CATCH_UP_LOOKBACK_DAYS,
  SCAN_KINDS,
  SCAN_OVERLAP_MINUTES,
  planScan,
  stampScan,
} from '../src/scan.js';

const MINUTE = 60_000;
const now = new Date('2026-09-09T12:00:00Z');
const minutesBefore = (n) => new Date(now.getTime() - n * MINUTE);
const iso = (d) => d.toISOString();

test('manual run is always a full scan with no lower bound', () => {
  const state = { lastRunAt: iso(minutesBefore(2)), lastCatchUpAt: iso(minutesBefore(2)) };
  const plan = planScan(state, { manual: true, now });
  assert.equal(plan.kind, SCAN_KINDS.full);
  assert.equal(plan.fromDate, undefined);
});

test('first scheduled run is a catch-up over the lookback window', () => {
  const plan = planScan(undefined, { now });
  assert.equal(plan.kind, SCAN_KINDS.catchUp);
  assert.equal(plan.fromDate.getTime(), now.getTime() - CATCH_UP_LOOKBACK_DAYS * 24 * 60 * MINUTE);
});

test('steady state is incremental with the overlap applied', () => {
  const lastRun = minutesBefore(2);
  const state = { lastRunAt: iso(lastRun), lastCatchUpAt: iso(minutesBefore(5)) };
  const plan = planScan(state, { now });
  assert.equal(plan.kind, SCAN_KINDS.incremental);
  assert.equal(plan.fromDate.getTime(), lastRun.getTime() - SCAN_OVERLAP_MINUTES * MINUTE);
});

test('catch-up becomes due once CATCH_UP_EVERY_MINUTES have passed', () => {
  const justUnder = {
    lastRunAt: iso(minutesBefore(2)),
    lastCatchUpAt: iso(minutesBefore(CATCH_UP_EVERY_MINUTES - 1)),
  };
  assert.equal(planScan(justUnder, { now }).kind, SCAN_KINDS.incremental);

  const exactly = {
    lastRunAt: iso(minutesBefore(2)),
    lastCatchUpAt: iso(minutesBefore(CATCH_UP_EVERY_MINUTES)),
  };
  assert.equal(planScan(exactly, { now }).kind, SCAN_KINDS.catchUp);
});

test('a message backdated by hours is inside the catch-up window', () => {
  // The report that motivated this: sender Date seven hours before arrival, on
  // a rule ticking every two minutes. Never inside an incremental window.
  const state = { lastRunAt: iso(minutesBefore(2)), lastCatchUpAt: iso(minutesBefore(31)) };
  const backdated = minutesBefore(7 * 60);
  const plan = planScan(state, { now });
  assert.equal(plan.kind, SCAN_KINDS.catchUp);
  assert.ok(plan.fromDate <= backdated);
});

test('garbage timestamps fall back to a catch-up rather than throwing', () => {
  assert.equal(planScan({ lastRunAt: 'nope', lastCatchUpAt: 'nope' }, { now }).kind, SCAN_KINDS.catchUp);
  assert.equal(
    planScan({ lastRunAt: 'nope', lastCatchUpAt: iso(minutesBefore(1)) }, { now }).kind,
    SCAN_KINDS.catchUp,
  );
});

test('stampScan advances lastRunAt on every kind and lastCatchUpAt only on wide scans', () => {
  const prior = { lastRunAt: iso(minutesBefore(10)), lastCatchUpAt: iso(minutesBefore(20)) };

  const inc = stampScan(prior, SCAN_KINDS.incremental, now);
  assert.equal(inc.lastRunAt, iso(now));
  assert.equal(inc.lastCatchUpAt, prior.lastCatchUpAt);

  for (const kind of [SCAN_KINDS.catchUp, SCAN_KINDS.full]) {
    const wide = stampScan(prior, kind, now);
    assert.equal(wide.lastRunAt, iso(now));
    assert.equal(wide.lastCatchUpAt, iso(now));
  }

  // Never mutates, and tolerates absent prior state.
  assert.equal(prior.lastRunAt, iso(minutesBefore(10)));
  assert.deepEqual(stampScan(undefined, SCAN_KINDS.incremental, now), { lastRunAt: iso(now) });
});

test('state written by 0.2.0 (lastRunAt only) triggers a catch-up, then goes incremental', () => {
  const legacy = { lastRunAt: iso(minutesBefore(2)) };
  const first = planScan(legacy, { now });
  assert.equal(first.kind, SCAN_KINDS.catchUp);

  const after = stampScan(legacy, first.kind, now);
  const later = new Date(now.getTime() + 2 * MINUTE);
  assert.equal(planScan(after, { now: later }).kind, SCAN_KINDS.incremental);
});
