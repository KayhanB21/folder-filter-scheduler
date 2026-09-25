/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The advanced settings: the scan timings that used to be constants, plus the
 * new-mail trigger.
 *
 * Pure and free of extension APIs, like matcher.js and scan.js, so the clamping
 * below is unit-testable under plain Node.
 *
 * Every value is clamped rather than rejected. These arrive from a number input
 * and from imported files, and a missing or silly value must never be able to
 * turn a scan into something unbounded: `catchUpLookbackDays: 100000` would make
 * every run a full folder scan, and `catchUpEveryMinutes: 0` would make every
 * run a catch-up. The limits are wide enough to be useful and narrow enough that
 * no combination is pathological.
 */

export const ADVANCED_DEFAULTS = Object.freeze({
  runOnNewMail: true,
  newMailDelaySeconds: 10,
  scanOverlapMinutes: 90,
  catchUpEveryMinutes: 30,
  catchUpLookbackDays: 30,
});

/**
 * `newMailDelaySeconds` is capped hard at 15.
 *
 * The debounce is a plain setTimeout, and an MV3 event page is suspended after
 * roughly 30 seconds of inactivity. Each arriving message resets that idle
 * clock, so a timer well inside 30 seconds fires reliably and a longer one
 * races the suspension. `alarms` cannot stand in: its minimum is a minute.
 */
export const ADVANCED_LIMITS = Object.freeze({
  newMailDelaySeconds: { min: 1, max: 15, label: 'delay before running on new mail (seconds)' },
  scanOverlapMinutes: { min: 0, max: 1440, label: 'incremental scan overlap (minutes)' },
  catchUpEveryMinutes: { min: 1, max: 1440, label: 'catch-up scan interval (minutes)' },
  catchUpLookbackDays: { min: 1, max: 365, label: 'catch-up scan lookback (days)' },
});

function clampInteger(raw, { min, max }, fallback) {
  // Absent is not the same as wrong: a value that was never set falls back to
  // the default without complaint, while junk or an out-of-range number is
  // clamped and reported.
  if (raw === undefined || raw === null || raw === '') return { value: fallback, problem: false };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { value: fallback, problem: true };
  const floored = Math.floor(n);
  if (floored < min) return { value: min, problem: true };
  if (floored > max) return { value: max, problem: true };
  return { value: floored, problem: false };
}

/**
 * Rebuild the advanced settings from untrusted input.
 *
 * @param {object} [raw] whatever was stored, imported, or typed
 * @returns {{settings: object, problems: string[]}} problems name the values
 *   that were out of range, so the options page can say so rather than silently
 *   replacing what the user typed.
 */
export function sanitizeAdvanced(raw) {
  const problems = [];
  const settings = { runOnNewMail: raw?.runOnNewMail !== false };

  for (const [key, limit] of Object.entries(ADVANCED_LIMITS)) {
    const { value, problem } = clampInteger(raw?.[key], limit, ADVANCED_DEFAULTS[key]);
    settings[key] = value;
    if (problem) problems.push(`${limit.label} must be ${limit.min}-${limit.max}, using ${value}`);
  }
  return { settings, problems };
}

/** True when every value already equals its default. Drives "Restore defaults". */
export function isDefaultAdvanced(settings) {
  return Object.keys(ADVANCED_DEFAULTS).every((k) => settings?.[k] === ADVANCED_DEFAULTS[k]);
}

/**
 * Whether the schedule alarm must be (re)created. Thunderbird wakes the event
 * page for every new message, and re-creating the alarm on each wake restarts
 * its countdown, so steady mail kept pushing the scheduled run back (#12).
 */
export function alarmNeedsReset(alarm, minutes) {
  return !alarm || alarm.periodInMinutes !== minutes;
}
