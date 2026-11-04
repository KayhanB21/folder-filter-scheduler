/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cron expressions for a rule's own schedule.
 *
 * Pure and free of extension APIs, like matcher.js and scan.js. The add-on has
 * no dependencies, so the parser lives here. It covers the standard five
 * fields (minute, hour, day of month, month, day of week) with lists, ranges,
 * steps, and English month and weekday names. Times are the computer's local
 * time, which is what a user who writes "0 21 * * *" means.
 *
 * The error messages and the plain-words description are shown on the
 * options page, so they come from the message catalog (see i18n.js).
 */

import { formatList, plural, t, uiLanguage } from './i18n.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const abbreviations = (names, first) =>
  Object.fromEntries(names.map((name, i) => [name.slice(0, 3).toLowerCase(), i + first]));

// The names typed in an expression are English in every language, as in cron.
const FIELDS = [
  { key: 'minute', get label() { return t('cron_fieldMinute'); }, min: 0, max: 59 },
  { key: 'hour', get label() { return t('cron_fieldHour'); }, min: 0, max: 23 },
  { key: 'day', get label() { return t('cron_fieldDay'); }, min: 1, max: 31 },
  { key: 'month', get label() { return t('cron_fieldMonth'); }, min: 1, max: 12, names: abbreviations(MONTH_NAMES, 1) },
  // 7 is accepted as Sunday, as cron does, and folded to 0.
  { key: 'weekday', get label() { return t('cron_fieldWeekday'); }, min: 0, max: 7, names: abbreviations(DAY_NAMES, 0) },
];

/** Longest expression accepted. Generous for a real one, small enough to parse safely. */
export const CRON_MAX_LENGTH = 100;

const MINUTE = 60_000;

function parseNumber(text, spec) {
  const named = spec.names?.[text.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d{1,2}$/.test(text)) throw new Error(t('cron_errorInvalid', text, spec.label));
  const n = Number(text);
  if (n < spec.min || n > spec.max) {
    throw new Error(t('cron_errorOutOfRange', spec.label, spec.min, spec.max, n));
  }
  return n;
}

function parseField(text, spec) {
  const values = new Set();
  for (const part of text.split(',')) {
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined || range === '' || stepText === '') {
      throw new Error(t('cron_errorInvalid', part, spec.label));
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1) {
        throw new Error(t('cron_errorStep', stepText, spec.label));
      }
      step = Number(stepText);
    }

    let from;
    let to;
    if (range === '*') {
      from = spec.min;
      to = spec.key === 'weekday' ? 6 : spec.max;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined) throw new Error(t('cron_errorRange', range, spec.label));
      from = parseNumber(a, spec);
      to = parseNumber(b, spec);
      if (from > to) throw new Error(t('cron_errorBackwards', range, spec.label));
    } else {
      from = parseNumber(range, spec);
      // "5/15" means "from 5, every 15", as cron reads it.
      to = stepText === undefined ? from : spec.max;
    }
    for (let v = from; v <= to; v += step) values.add(spec.key === 'weekday' && v === 7 ? 0 : v);
  }

  const size = spec.key === 'weekday' ? 7 : spec.max - spec.min + 1;
  const stepMatch = /^\*\/(\d+)$/.exec(text);
  return {
    values,
    // True when the field does not narrow anything, however it was written.
    any: values.size === size,
    // Set for the plain "*/n" form only, which reads as "every n".
    every: stepMatch && Number(stepMatch[1]) > 1 ? Number(stepMatch[1]) : null,
  };
}

/**
 * Parse a five-field cron expression.
 *
 * @param {string} expression
 * @returns {{ok: true, expression: string, minute: object, hour: object, day: object, month: object, weekday: object} | {ok: false, error: string}}
 */
export function parseCron(expression) {
  const text = String(expression ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return { ok: false, error: t('cron_errorEmpty') };
  if (text.length > CRON_MAX_LENGTH) return { ok: false, error: t('cron_errorTooLong') };

  const parts = text.split(' ');
  if (parts.length !== FIELDS.length) {
    return { ok: false, error: t('cron_errorFieldCount', parts.length) };
  }

  const cron = { ok: true, expression: text };
  try {
    FIELDS.forEach((spec, i) => {
      cron[spec.key] = parseField(parts[i], spec);
    });
  } catch (e) {
    return { ok: false, error: e.message.charAt(0).toUpperCase() + e.message.slice(1) };
  }
  return cron;
}

/**
 * A rule's own schedule, parsed, or null when the rule uses the default timer.
 * An expression that does not parse counts as no schedule, so a rule with a
 * damaged one keeps running on the default timer.
 */
export function scheduleOf(rule) {
  if (rule?.schedule?.enabled !== true) return null;
  const cron = parseCron(rule.schedule.cron);
  return cron.ok ? cron : null;
}

/**
 * The stored shape of a schedule, rebuilt from untrusted input. It is on only
 * for a literal `true` with an expression that parses.
 */
export function sanitizeSchedule(raw) {
  const cron = parseCron(raw?.cron);
  const text = cron.ok ? cron.expression : String(raw?.cron ?? '').trim().slice(0, CRON_MAX_LENGTH);
  return { enabled: raw?.enabled === true && cron.ok, cron: text };
}

/**
 * Cron's day rule: when both the day of month and the day of week are
 * narrowed, a date matching either one counts.
 */
function dayMatches(cron, date) {
  const day = cron.day.values.has(date.getDate());
  const weekday = cron.weekday.values.has(date.getDay());
  if (cron.day.any) return weekday;
  if (cron.weekday.any) return day;
  return day || weekday;
}

/**
 * The first matching minute strictly after `after`, in local time, or null
 * when nothing matches in the next five years ("0 0 30 2 *").
 *
 * Every step moves forward, by a calendar day or month through the Date
 * constructor and by minutes through the timestamp, so a clock change can
 * neither stall the search nor return a time that does not exist.
 */
export function nextRun(cron, after = new Date()) {
  let t = new Date(after.getTime());
  t.setSeconds(0, 0);
  t = new Date(t.getTime() + MINUTE);
  const limit = after.getTime() + 5 * 366 * 24 * 60 * MINUTE;

  while (t.getTime() <= limit) {
    if (!cron.month.values.has(t.getMonth() + 1)) {
      t = new Date(t.getFullYear(), t.getMonth() + 1, 1);
    } else if (!dayMatches(cron, t)) {
      t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    } else if (!cron.hour.values.has(t.getHours())) {
      t = new Date(t.getTime() + (60 - t.getMinutes()) * MINUTE);
    } else if (!cron.minute.values.has(t.getMinutes())) {
      t = new Date(t.getTime() + MINUTE);
    } else {
      return t;
    }
  }
  return null;
}

/**
 * Whether a rule's alarm has to be created or moved.
 *
 * `applySettings` runs on every wake, so an alarm already set for the right
 * minute is left alone. One whose time has passed is about to fire, and
 * replacing it would skip that run.
 */
export function cronAlarmNeedsReset(alarm, when, now = Date.now()) {
  if (!alarm) return true;
  if (alarm.scheduledTime <= now) return false;
  return Math.abs(alarm.scheduledTime - when) >= 1000;
}

/**
 * Whether a scheduled time passed since the rule last ran, which happens when
 * Thunderbird was closed at that time. A rule that has never run has missed
 * nothing.
 */
export function missedRun(cron, lastRunAt, now = new Date()) {
  const last = new Date(lastRunAt ?? NaN);
  if (Number.isNaN(last.getTime())) return false;
  const due = nextRun(cron, last);
  return due !== null && due.getTime() <= now.getTime();
}

// --- Plain-words description ------------------------------------------------

/*
 * Each piece of the sentence is a message with placeholders, so a language
 * can put the parts in its own order. Weekday and month names, and the way a
 * list is joined ("a, b, and c"), come from Intl in the interface language.
 */

const pad = (n) => String(n).padStart(2, '0');
const sorted = (field) => [...field.values].sort((a, b) => a - b);
const time = (h, m) => `${pad(h)}:${pad(m)}`;

const joinList = (items) => formatList(items, 'conjunction');

/** January 1, 2023 was a Sunday, so day `d` of that week is weekday `d`. */
const dayName = (d) =>
  new Intl.DateTimeFormat(uiLanguage(), { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2023, 0, 1 + d));
const monthName = (m) =>
  new Intl.DateTimeFormat(uiLanguage(), { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2023, m - 1, 1));

/** Sorted values as words, with three or more in a row folded to "a through b". */
function listValues(values, name = String) {
  const out = [];
  for (let i = 0; i < values.length; ) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j += 1;
    if (j - i >= 2) out.push(t('cron_range', name(values[i]), name(values[j])));
    else for (let k = i; k <= j; k += 1) out.push(name(values[k]));
    i = j + 1;
  }
  return joinList(out);
}

const isRun = (values) => values.every((v, i) => i === 0 || v === values[i - 1] + 1);

function describeHours(hour) {
  if (hour.every) return plural('cron_everyHours', hour.every, hour.every);
  const hours = sorted(hour);
  if (hours.length > 1 && isRun(hours)) {
    return t('cron_betweenHours', time(hours[0], 0), time(hours[hours.length - 1], 59));
  }
  return plural('cron_duringHours', hours.length, listValues(hours));
}

/** The time-of-day half, and whether it names fixed clock times. */
function describeTime({ minute, hour }) {
  const minutes = sorted(minute);
  const hours = sorted(hour);

  if (!hour.any && !hour.every && minutes.length * hours.length <= 6) {
    const times = hours.flatMap((h) => minutes.map((m) => time(h, m)));
    return { text: t('cron_atTimes', joinList(times)), fixed: true };
  }

  let text;
  if (minute.any) text = t('cron_everyMinute');
  else if (minute.every) text = plural('cron_everyMinutes', minute.every, minute.every);
  else if (minutes.length === 1 && hour.any) {
    return { text: minutes[0] === 0 ? t('cron_everyHourOnTheHour') : t('cron_everyHourAtMinute', minutes[0]) };
  } else text = plural('cron_atMinutes', minutes.length, listValues(minutes));

  return { text: hour.any ? text : t('cron_timeAndHours', text, describeHours(hour)) };
}

function describeDays({ day, weekday }) {
  const parts = [];
  if (!day.any) {
    const days = sorted(day);
    parts.push(plural('cron_onDaysOfMonth', days.length, listValues(days)));
  }
  if (!weekday.any) parts.push(t('cron_onWeekdays', listValues(sorted(weekday), dayName)));
  return formatList(parts, 'disjunction');
}

/**
 * A sentence a person can check the expression against, without a final
 * period: "At 21:00 every day", "Every 5 minutes, between 09:00 and 17:59 on
 * Monday through Friday".
 */
export function describeCron(cron) {
  const { text, fixed } = describeTime(cron);
  const days = describeDays(cron);
  const months = cron.month.any ? '' : t('cron_inMonths', listValues(sorted(cron.month), monthName));
  const when = days || (fixed && !months ? t('cron_everyDay') : '');
  const withDays = when ? t('cron_withDays', text, when) : text;
  return months ? t('cron_withMonths', withDays, months) : withDays;
}
