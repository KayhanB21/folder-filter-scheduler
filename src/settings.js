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
  logScheduleRuns: false,
  showMenu: true,
  shortName: false,
  authOwnCheck: true,
  authPrefer: 'own',
  authDohServer: 'cloudflare',
  authTrustedServers: '',
});

/**
 * The DNS over HTTPS servers the own DKIM check can use. The manifest lists
 * each origin as an optional host permission, so the add-on asks for the one
 * chosen before it sends any lookup.
 */
export const AUTH_DOH_SERVERS = Object.freeze({
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/dns-query',
});

/** The origin pattern a DoH server needs as a host permission. */
export function dohOrigin(key) {
  const url = AUTH_DOH_SERVERS[key];
  return url ? `${new URL(url).origin}/*` : null;
}

const AUTH_PREFER_VALUES = Object.freeze(['own', 'provider']);

/**
 * The trusted authentication servers as a list. They are host names, such as
 * `mta.yahoo.com`, typed into one box and separated by commas or spaces.
 */
export function trustedServerList(text) {
  const names = String(text ?? '')
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter((name) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name));
  return [...new Set(names)];
}

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
  const settings = {
    runOnNewMail: raw?.runOnNewMail !== false,
    // Off unless literally true. A rule on a 1-minute schedule writes several
    // log lines a minute, which pushes everything else out of the diagnostics
    // log within hours. See `quiet` in background.js.
    logScheduleRuns: raw?.logScheduleRuns === true,
    // On unless literally false, so a config saved before the setting existed
    // keeps its right-click menu.
    showMenu: raw?.showMenu !== false,
    shortName: raw?.shortName === true,
    authOwnCheck: raw?.authOwnCheck !== false,
    authTrustedServers: trustedServerList(raw?.authTrustedServers).join(', '),
  };

  // Two settings with a fixed list of values. Anything else falls back to the
  // default and is reported, like a number out of range.
  const pick = (key, allowed, label) => {
    const value = raw?.[key];
    if (value === undefined || value === null || value === '') return ADVANCED_DEFAULTS[key];
    if (allowed.includes(value)) return value;
    problems.push(`${label} must be one of ${allowed.join(', ')}, using ${ADVANCED_DEFAULTS[key]}`);
    return ADVANCED_DEFAULTS[key];
  };
  settings.authPrefer = pick('authPrefer', AUTH_PREFER_VALUES, 'result to use when the checks disagree');
  settings.authDohServer = pick('authDohServer', Object.keys(AUTH_DOH_SERVERS), 'DNS server');

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
