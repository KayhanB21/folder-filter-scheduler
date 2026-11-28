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

import {
  AGE_OPERATORS,
  HAS_TAG,
  STATE_OPERATORS,
  ageDays,
  isAgeCondition,
  isStateCondition,
  isTagCondition,
} from './matcher.js';
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

/**
 * Record the user-visible outcome of one rule execution without touching the
 * scan watermarks (`lastRunAt` / `lastCatchUpAt`).
 *
 * Called on every pass — including failed ones where the watermark must hold —
 * so each rule card can display when it last ran, how many messages matched,
 * and whether errors occurred. Carries counts and timestamps only, never PII.
 */
export function recordRuleRun(
  state,
  { at, scanned = 0, matched = 0, affected = 0, error = false, skippedHeaders = 0, skippedBodies = 0, authPending = 0 },
) {
  const when = at instanceof Date ? at.toISOString() : String(at ?? '');
  const lastStatus = {
    at: when,
    scanned: Math.max(0, Number(scanned) || 0),
    matched: Math.max(0, Number(matched) || 0),
    affected: Math.max(0, Number(affected) || 0),
    error: error === true,
    ...(skippedHeaders > 0 ? { skippedHeaders } : {}),
    ...(skippedBodies > 0 ? { skippedBodies } : {}),
    ...(authPending > 0 ? { authPending } : {}),
  };
  return { ...(state ?? {}), lastStatus };
}

/**
 * Bucket an elapsed duration into a translatable relative-time token for rule
 * status lines: `{ unit: 'justNow' | 'minutes' | 'hours' | 'days', value }`.
 */
export function relativeTimeParts(timestamp, now = new Date()) {
  const date = parseDate(timestamp);
  if (!date) return null;
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(diffMs / MINUTE);
  if (minutes < 1) return { unit: 'justNow', value: 0 };
  if (minutes < 60) return { unit: 'minutes', value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: 'hours', value: hours };
  return { unit: 'days', value: Math.floor(hours / 24) };
}

const SAMPLE_TEXT_MAX = 160;
const trimSample = (text) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > SAMPLE_TEXT_MAX ? `${s.slice(0, SAMPLE_TEXT_MAX - 1)}…` : s;
};

/**
 * Compact, display-only summary of one matched MessageHeader for dry-run
 * preview. Returned transiently to the options page and never persisted or
 * logged to diagnostics.
 */
export function dryRunSampleOf(header, folderId = null) {
  const d = parseDate(header?.date);
  return {
    id: header?.id ?? null,
    subject: trimSample(header?.subject),
    from: trimSample(header?.author),
    folderId: header?.folder?.id ?? folderId ?? null,
    date: d ? d.toISOString() : null,
  };
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

/**
 * Push cheap `all` (AND) conditions (`read`, `star`, positive `tag`) down into
 * Thunderbird's Manifest V3 `messages.query()` so big folders return far fewer
 * headers.
 *
 * Returns `{ read?, flagged?, tags?, impossible? }`. `impossible: true` means
 * the rule carries contradictory demands (such as read AND unread) so the folder
 * scan can be skipped entirely. The matcher still re-evaluates every returned
 * message, so pushdown only ever narrows the candidate set, never decides it.
 */
export function queryFilterFor(rule) {
  if (rule?.match !== 'all') return {};
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];

  let read;
  let flagged;
  const requiredTags = {};
  const forbiddenTags = new Set();

  for (const c of conditions) {
    if (isStateCondition(c)) {
      const field = String(c.field).toLowerCase();
      if (field !== 'read' && field !== 'star') continue;
      if (c.operator !== STATE_OPERATORS.isOn && c.operator !== STATE_OPERATORS.isOff) continue;
      const wantsOn = (c.operator === STATE_OPERATORS.isOn) !== (c.negate === true);
      if (field === 'read') {
        if (read !== undefined && read !== wantsOn) return { impossible: true };
        read = wantsOn;
      } else {
        if (flagged !== undefined && flagged !== wantsOn) return { impossible: true };
        flagged = wantsOn;
      }
    } else if (isTagCondition(c) && c.operator === HAS_TAG) {
      const key = typeof c.tagKey === 'string' ? c.tagKey.trim() : '';
      if (!key) continue;
      if (c.negate === true) {
        if (requiredTags[key]) return { impossible: true };
        forbiddenTags.add(key);
      } else {
        if (forbiddenTags.has(key)) return { impossible: true };
        requiredTags[key] = true;
      }
    }
  }

  const filter = {};
  if (read !== undefined) filter.read = read;
  if (flagged !== undefined) filter.flagged = flagged;
  if (Object.keys(requiredTags).length > 0) {
    filter.tags = { tags: requiredTags, mode: 'all' };
  }
  return filter;
}

export const SCAN_PROGRESS_KEY = 'scanProgress';
export const SCAN_PROGRESS_CAP = 50_000;

/**
 * Session-scoped resume progress for header/body scans cut short by the run
 * time budget.
 *
 * Without a resume set, a rule scanning a large uncached IMAP folder would
 * check messages 1..200, hit the 20-second budget, hold the watermark, and
 * restart at message 1 on every subsequent run forever. Remembering the message
 * ids already evaluated in the incomplete pass (invalidated if the rule's
 * fingerprint changes, and cleared as soon as a pass finishes cleanly) lets
 * each run continue where the previous one left off.
 */
export function createScanProgress({ stored = {}, rules = null, cap = SCAN_PROGRESS_CAP } = {}) {
  const allowedIds = Array.isArray(rules) ? new Set(rules.map((r) => r?.id).filter(Boolean)) : null;
  const progress = {};
  let dirty = false;

  for (const [ruleId, entry] of Object.entries(stored ?? {})) {
    if (allowedIds && !allowedIds.has(ruleId)) {
      dirty = true;
      continue;
    }
    if (!entry || typeof entry !== 'object' || typeof entry.fingerprint !== 'string' || !Array.isArray(entry.seenIds)) {
      dirty = true;
      continue;
    }
    const cleanIds = entry.seenIds.filter((id) => typeof id === 'number' && Number.isInteger(id));
    if (cleanIds.length === 0) {
      dirty = true;
      continue;
    }
    const rawMatched = Array.isArray(entry.matchedIds) ? entry.matchedIds : [];
    const cleanMatched = rawMatched.filter((id) => typeof id === 'number' && Number.isInteger(id));
    const cappedMatched = cleanMatched.length > cap ? cleanMatched.slice(cleanMatched.length - cap) : cleanMatched;
    progress[ruleId] = {
      fingerprint: entry.fingerprint,
      seenIds: cleanIds.length > cap ? cleanIds.slice(cleanIds.length - cap) : cleanIds,
      ...(cappedMatched.length > 0 ? { matchedIds: cappedMatched } : {}),
    };
    if (
      cleanIds.length !== entry.seenIds.length ||
      cleanIds.length > cap ||
      cleanMatched.length !== rawMatched.length ||
      cleanMatched.length > cap
    ) {
      dirty = true;
    }
  }

  return {
    isDirty() {
      return dirty;
    },

    /** Evaluated and matched message ids from an interrupted pass of this exact rule. */
    progressFor(ruleId, fingerprint) {
      const entry = ruleId ? progress[ruleId] : null;
      if (!entry || entry.fingerprint !== fingerprint) {
        return { seenIds: new Set(), matchedIds: new Set() };
      }
      return {
        seenIds: new Set(entry.seenIds),
        matchedIds: new Set(entry.matchedIds ?? []),
      };
    },

    /** Message ids already evaluated in an interrupted pass of this exact rule. */
    seenSetFor(ruleId, fingerprint) {
      return this.progressFor(ruleId, fingerprint).seenIds;
    },

    /**
     * Remember evaluated ids (and, for stopping rules, matched ids) when a scan
     * hits the read budget before finishing.
     */
    recordPartial(ruleId, fingerprint, seenSet, matchedSet = null) {
      if (!ruleId || !fingerprint) return;
      const list = [...seenSet].filter((id) => typeof id === 'number' && Number.isInteger(id));
      if (list.length === 0) return;
      const matchedList = matchedSet
        ? [...matchedSet].filter((id) => typeof id === 'number' && Number.isInteger(id))
        : [];
      const cappedMatched = matchedList.length > cap ? matchedList.slice(matchedList.length - cap) : matchedList;
      progress[ruleId] = {
        fingerprint,
        seenIds: list.length > cap ? list.slice(list.length - cap) : list,
        ...(cappedMatched.length > 0 ? { matchedIds: cappedMatched } : {}),
      };
      dirty = true;
    },

    /** Clear resume progress once a rule finishes a pass without hitting the budget. */
    clear(ruleId) {
      if (ruleId && Object.hasOwn(progress, ruleId)) {
        delete progress[ruleId];
        dirty = true;
      }
    },

    snapshot() {
      return progress;
    },
  };
}
