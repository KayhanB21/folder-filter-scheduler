/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Decides how much of a folder a run should look at.
 *
 * Pure, no extension APIs, same convention as matcher.js. The background script
 * hands in a rule's persisted run state and gets back a scan plan.
 *
 * Three kinds of scan:
 *
 * - `incremental`: only mail dated since the previous run, plus an overlap.
 *   Cheap enough to do every few minutes even when a rule needs a per-message
 *   header read.
 * - `catchUp`: the last CATCH_UP_LOOKBACK_DAYS of the folder, run on the first
 *   scheduled pass and then every CATCH_UP_EVERY_MINUTES. This exists because
 *   `messages.query({fromDate})` filters on the Date header, which the sender
 *   controls. Spam with a Date hours behind its real arrival time never falls
 *   inside an incremental window, so without a periodic wider pass it would
 *   never be seen by a scheduled run at all. The catch-up bounds that miss to
 *   CATCH_UP_EVERY_MINUTES at worst.
 * - `full`: the whole folder, no lower bound. Only for "Run all rules now",
 *   the user's escape hatch for backlog and for mail backdated beyond the
 *   catch-up lookback.
 */

import { AGE_OPERATORS, ageDays, isAgeCondition } from './matcher.js';
import { ADVANCED_DEFAULTS } from './settings.js';

/**
 * The timings are user-adjustable under Advanced on the options page; these
 * are the defaults, and what `planScan` falls back to when no settings are
 * passed. settings.js owns the clamping.
 */
export const SCAN_OVERLAP_MINUTES = ADVANCED_DEFAULTS.scanOverlapMinutes;
export const CATCH_UP_EVERY_MINUTES = ADVANCED_DEFAULTS.catchUpEveryMinutes;
export const CATCH_UP_LOOKBACK_DAYS = ADVANCED_DEFAULTS.catchUpLookbackDays;

export const SCAN_KINDS = Object.freeze({
  full: 'full',
  catchUp: 'catchUp',
  incremental: 'incremental',
});

const MINUTE = 60_000;

function parseDate(value) {
  if (value == null) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Plan a scan for one rule.
 *
 * @param {{lastRunAt?: string, lastCatchUpAt?: string}|undefined} state
 * @param {{manual?: boolean, now?: Date, settings?: object}} [options]
 * @returns {{kind: string, fromDate: Date|undefined}}
 */
export function planScan(state, { manual = false, now = new Date(), settings } = {}) {
  if (manual) return { kind: SCAN_KINDS.full, fromDate: undefined };

  const overlapMinutes = settings?.scanOverlapMinutes ?? SCAN_OVERLAP_MINUTES;
  const everyMinutes = settings?.catchUpEveryMinutes ?? CATCH_UP_EVERY_MINUTES;
  const lookbackDays = settings?.catchUpLookbackDays ?? CATCH_UP_LOOKBACK_DAYS;
  const catchUp = () => ({
    kind: SCAN_KINDS.catchUp,
    fromDate: new Date(now.getTime() - lookbackDays * 24 * 60 * MINUTE),
  });

  const lastCatchUp = parseDate(state?.lastCatchUpAt);
  if (!lastCatchUp || now.getTime() - lastCatchUp.getTime() >= everyMinutes * MINUTE) {
    return catchUp();
  }

  // A missing lastRunAt with a valid lastCatchUpAt cannot happen through
  // stampScan, but state is user-visible storage, so fall back to a catch-up
  // rather than trusting it.
  const lastRun = parseDate(state?.lastRunAt);
  if (!lastRun) return catchUp();

  return {
    kind: SCAN_KINDS.incremental,
    fromDate: new Date(lastRun.getTime() - overlapMinutes * MINUTE),
  };
}

/**
 * The run state to persist after a clean pass. Any scan advances lastRunAt; a
 * full or catch-up scan also resets the catch-up timer, since both cover at
 * least what a catch-up would.
 */
export function stampScan(state, kind, startedAt) {
  const at = startedAt.toISOString();
  const next = { ...(state ?? {}), lastRunAt: at };
  if (kind === SCAN_KINDS.full || kind === SCAN_KINDS.catchUp) next.lastCatchUpAt = at;
  return next;
}

const DAY = 24 * 60 * MINUTE;

/**
 * Translate a scan plan into `messages.query` bounds for one rule.
 *
 * An age condition is the inverse of an incremental scan: a message that turns
 * N days old today arrived N days ago, so it never sits inside a window that
 * starts at the previous run. Any rule with an age condition therefore drops
 * `fromDate` altogether. When the rule is `all` (AND) and demands "older than
 * N", the query can be bounded from above instead, so Thunderbird returns only
 * the old tail of the folder rather than the whole thing. A negated "newer
 * than N" is the same demand and gets the same bound. The matcher re-checks
 * every message, so these bounds only ever narrow the work, never decide it.
 */
export function queryBoundsFor(rule, plan, now = new Date()) {
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  const ages = conditions.filter(isAgeCondition);
  if (ages.length === 0) return { fromDate: plan?.fromDate };

  const bounds = { fromDate: undefined, toDate: undefined };
  if (rule.match !== 'all') return bounds;

  const olderThan = ages
    .filter(
      (c) =>
        (c.operator === AGE_OPERATORS.olderThan && !c.negate) ||
        (c.operator === AGE_OPERATORS.newerThan && c.negate === true),
    )
    .map(ageDays)
    .filter((n) => n !== null);
  if (olderThan.length > 0) bounds.toDate = new Date(now.getTime() - Math.max(...olderThan) * DAY);
  return bounds;
}
