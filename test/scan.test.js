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
  SCAN_PROGRESS_CAP,
  SCAN_PROGRESS_KEY,
  createScanProgress,
  dryRunSampleOf,
  planScan,
  recordRuleRun,
  relativeTimeParts,
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

test('the advanced settings override the default timings', () => {
  const settings = { scanOverlapMinutes: 5, catchUpEveryMinutes: 120, catchUpLookbackDays: 2 };
  const lastRun = minutesBefore(10);

  // The catch-up is not due yet at 60 minutes when the interval is 120.
  const state = { lastRunAt: iso(lastRun), lastCatchUpAt: iso(minutesBefore(60)) };
  const incremental = planScan(state, { now, settings });
  assert.equal(incremental.kind, SCAN_KINDS.incremental);
  assert.equal(incremental.fromDate.getTime(), lastRun.getTime() - 5 * MINUTE);

  const due = planScan({ ...state, lastCatchUpAt: iso(minutesBefore(120)) }, { now, settings });
  assert.equal(due.kind, SCAN_KINDS.catchUp);
  assert.equal(due.fromDate.getTime(), now.getTime() - 2 * 24 * 60 * MINUTE);
});

test('an overlap of zero starts the scan exactly at the previous run', () => {
  const lastRun = minutesBefore(10);
  const plan = planScan(
    { lastRunAt: iso(lastRun), lastCatchUpAt: iso(minutesBefore(1)) },
    { now, settings: { scanOverlapMinutes: 0 } },
  );
  assert.equal(plan.fromDate.getTime(), lastRun.getTime());
});

test('a manual run ignores the advanced settings entirely', () => {
  const plan = planScan({ lastRunAt: iso(minutesBefore(1)) }, {
    manual: true,
    now,
    settings: { catchUpLookbackDays: 1 },
  });
  assert.equal(plan.kind, SCAN_KINDS.full);
  assert.equal(plan.fromDate, undefined);
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

// --- Query bounds for age rules ---------------------------------------------

import { queryBoundsFor, queryFilterFor } from '../src/scan.js';

const DAY = 24 * 60 * MINUTE;
const older = (days, extra = {}) => ({ field: 'age', operator: 'olderThan', days, ...extra });
const newer = (days, extra = {}) => ({ field: 'age', operator: 'newerThan', days, ...extra });
const subj = { field: 'subject', operator: 'contains', value: 'x' };
const incrementalPlan = { kind: SCAN_KINDS.incremental, fromDate: minutesBefore(92) };

test('a rule without an age condition keeps the plan lower bound', () => {
  const b = queryBoundsFor({ match: 'any', conditions: [subj] }, incrementalPlan, now);
  assert.equal(b.fromDate, incrementalPlan.fromDate);
  assert.equal(b.toDate, undefined);
});

test('any rule with an age condition drops the lower bound entirely', () => {
  const b = queryBoundsFor({ match: 'any', conditions: [subj, older(30)] }, incrementalPlan, now);
  assert.equal(b.fromDate, undefined);
  assert.equal(b.toDate, undefined);
});

test('all rule with olderThan narrows the query from above', () => {
  const b = queryBoundsFor({ match: 'all', conditions: [subj, older(30)] }, incrementalPlan, now);
  assert.equal(b.fromDate, undefined);
  assert.equal(b.toDate.getTime(), now.getTime() - 30 * DAY);
});

test('the tightest olderThan wins, and a negated newerThan counts as olderThan', () => {
  const both = queryBoundsFor({ match: 'all', conditions: [older(10), older(45)] }, incrementalPlan, now);
  assert.equal(both.toDate.getTime(), now.getTime() - 45 * DAY);

  const negated = queryBoundsFor({ match: 'all', conditions: [newer(7, { negate: true })] }, incrementalPlan, now);
  assert.equal(negated.toDate.getTime(), now.getTime() - 7 * DAY);
});

test('newerThan, negated olderThan, or an unusable day count give no upper bound', () => {
  for (const conds of [[newer(7)], [older(7, { negate: true })], [older(0)], [older('x')]]) {
    const b = queryBoundsFor({ match: 'all', conditions: conds }, incrementalPlan, now);
    assert.equal(b.fromDate, undefined);
    assert.equal(b.toDate, undefined, JSON.stringify(conds));
  }
});

// --- Query pushdown for cheap AND conditions ---------------------------------

test('queryFilterFor does nothing on OR (any) rules', () => {
  const filter = queryFilterFor({
    match: 'any',
    conditions: [
      { field: 'read', operator: 'isOff' },
      { field: 'star', operator: 'isOn' },
      { field: 'tag', operator: 'hasTag', tagKey: '$label1' },
    ],
  });
  assert.deepEqual(filter, {});
});

test('queryFilterFor pushes read, star, and positive tag conditions down on AND rules', () => {
  const filter = queryFilterFor({
    match: 'all',
    conditions: [
      { field: 'read', operator: 'isOff' },
      { field: 'star', operator: 'isOn' },
      { field: 'tag', operator: 'hasTag', tagKey: 'work' },
      { field: 'tag', operator: 'hasTag', tagKey: 'urgent' },
      { field: 'tag', operator: 'hasTag', tagKey: 'done', negate: true },
      { field: 'junk', operator: 'isOff' },
    ],
  });
  assert.deepEqual(filter, {
    read: false,
    flagged: true,
    tags: { tags: { work: true, urgent: true }, mode: 'all' },
  });

  // Negated state conditions flip cleanly too.
  assert.deepEqual(
    queryFilterFor({
      match: 'all',
      conditions: [
        { field: 'read', operator: 'isOff', negate: true },
        { field: 'star', operator: 'isOn', negate: true },
      ],
    }),
    { read: true, flagged: false },
  );
});

test('queryFilterFor marks contradictory AND demands as impossible', () => {
  assert.deepEqual(
    queryFilterFor({
      match: 'all',
      conditions: [
        { field: 'read', operator: 'isOn' },
        { field: 'read', operator: 'isOff' },
      ],
    }),
    { impossible: true },
  );
  assert.deepEqual(
    queryFilterFor({
      match: 'all',
      conditions: [
        { field: 'star', operator: 'isOn' },
        { field: 'star', operator: 'isOff' },
      ],
    }),
    { impossible: true },
  );
  assert.deepEqual(
    queryFilterFor({
      match: 'all',
      conditions: [
        { field: 'tag', operator: 'hasTag', tagKey: 'work' },
        { field: 'tag', operator: 'hasTag', tagKey: 'work', negate: true },
      ],
    }),
    { impossible: true },
  );
});

// --- Per-rule run status, relative time, and dry-run samples ----------------

test('recordRuleRun stores outcome without altering scan watermarks', () => {
  const prior = { lastRunAt: '2026-09-09T11:00:00.000Z', lastCatchUpAt: '2026-09-09T10:30:00.000Z' };
  const clean = recordRuleRun(prior, { at: now, scanned: 40, matched: 3, affected: 2, error: false });
  assert.equal(clean.lastRunAt, prior.lastRunAt);
  assert.equal(clean.lastCatchUpAt, prior.lastCatchUpAt);
  assert.deepEqual(clean.lastStatus, {
    at: now.toISOString(),
    scanned: 40,
    matched: 3,
    affected: 2,
    error: false,
  });

  const failed = recordRuleRun(undefined, {
    at: now,
    scanned: 10,
    matched: 0,
    affected: 0,
    error: true,
    skippedHeaders: 2,
    skippedBodies: 1,
    authPending: 3,
  });
  assert.equal(failed.lastRunAt, undefined);
  assert.deepEqual(failed.lastStatus, {
    at: now.toISOString(),
    scanned: 10,
    matched: 0,
    affected: 0,
    error: true,
    skippedHeaders: 2,
    skippedBodies: 1,
    authPending: 3,
  });
});

test('relativeTimeParts buckets elapsed durations cleanly', () => {
  assert.deepEqual(relativeTimeParts(new Date(now.getTime() - 20_000), now), { unit: 'justNow', value: 0 });
  assert.deepEqual(relativeTimeParts(minutesBefore(8), now), { unit: 'minutes', value: 8 });
  assert.deepEqual(relativeTimeParts(minutesBefore(150), now), { unit: 'hours', value: 2 });
  assert.deepEqual(relativeTimeParts(new Date(now.getTime() - 3 * DAY), now), { unit: 'days', value: 3 });
  assert.equal(relativeTimeParts('garbage', now), null);
});

test('dryRunSampleOf compacts header fields and trims long text', () => {
  const sample = dryRunSampleOf(
    {
      id: 42,
      subject: `  Hello\n  ${'x'.repeat(200)}`,
      author: 'Alice <alice@example.com>',
      folder: { id: 'acc://INBOX' },
      date: now,
    },
    'fallback',
  );
  assert.equal(sample.id, 42);
  assert.equal(sample.from, 'Alice <alice@example.com>');
  assert.equal(sample.folderId, 'acc://INBOX');
  assert.equal(sample.date, now.toISOString());
  assert.equal(sample.subject.length, 160);
  assert.ok(sample.subject.endsWith('…'));

  const minimal = dryRunSampleOf({ id: 7 }, 'fallback://Folder');
  assert.deepEqual(minimal, { id: 7, subject: '', from: '', folderId: 'fallback://Folder', date: null });
});

test('createScanProgress tracks partial passes and matched ids, invalidates on rule edit, prunes deleted rules, and caps size', () => {
  assert.equal(SCAN_PROGRESS_KEY, 'scanProgress');
  assert.equal(SCAN_PROGRESS_CAP, 50_000);

  const progress = createScanProgress({
    stored: {
      r1: { fingerprint: 'fp-v1', seenIds: [1, 2, 'bad', 3], matchedIds: [2, 'x'] },
      deleted: { fingerprint: 'fp-old', seenIds: [99], matchedIds: [99] },
      broken: { fingerprint: 123, seenIds: 'nope' },
    },
    rules: [{ id: 'r1' }, { id: 'r2' }],
    cap: 4,
  });

  assert.equal(progress.isDirty(), true);
  assert.deepEqual([...progress.seenSetFor('r1', 'fp-v1')], [1, 2, 3]);
  const loaded = progress.progressFor('r1', 'fp-v1');
  assert.deepEqual([...loaded.seenIds], [1, 2, 3]);
  assert.deepEqual([...loaded.matchedIds], [2]);
  // Editing the rule changes its fingerprint, so stale resume progress is ignored.
  assert.deepEqual([...progress.seenSetFor('r1', 'fp-v2')], []);
  assert.deepEqual([...progress.progressFor('r1', 'fp-v2').matchedIds], []);
  assert.equal(progress.snapshot().deleted, undefined);

  // Recording more ids respects cap by keeping the newest ids, including matched ids for stopping rules.
  progress.recordPartial('r1', 'fp-v1', new Set([1, 2, 3, 4, 5, 6]), new Set([2, 4, 5, 6, 7]));
  assert.deepEqual([...progress.seenSetFor('r1', 'fp-v1')], [3, 4, 5, 6]);
  assert.deepEqual([...progress.progressFor('r1', 'fp-v1').matchedIds], [4, 5, 6, 7]);

  // Clean completion clears both seen and matched resume entries.
  progress.clear('r1');
  assert.deepEqual([...progress.seenSetFor('r1', 'fp-v1')], []);
  assert.deepEqual([...progress.progressFor('r1', 'fp-v1').matchedIds], []);
  assert.equal(progress.snapshot().r1, undefined);
});
