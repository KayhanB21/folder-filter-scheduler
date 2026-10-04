/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cronAlarmNeedsReset,
  describeCron,
  missedRun,
  nextRun,
  parseCron,
  sanitizeSchedule,
  scheduleOf,
} from '../src/cron.js';

const cron = (expression) => {
  const parsed = parseCron(expression);
  assert.equal(parsed.ok, true, `${expression}: ${parsed.error}`);
  return parsed;
};
const values = (field) => [...field.values].sort((a, b) => a - b);
// Local time throughout, as the scheduler uses.
const at = (...parts) => new Date(...parts);

test('a plain expression parses into its five fields', () => {
  const c = cron('0 21 * * *');
  assert.deepEqual(values(c.minute), [0]);
  assert.deepEqual(values(c.hour), [21]);
  assert.equal(c.day.any && c.month.any && c.weekday.any, true);
});

test('lists, ranges, and steps expand', () => {
  assert.deepEqual(values(cron('0,15,30 * * * *').minute), [0, 15, 30]);
  assert.deepEqual(values(cron('* 9-12 * * *').hour), [9, 10, 11, 12]);
  assert.deepEqual(values(cron('*/20 * * * *').minute), [0, 20, 40]);
  assert.deepEqual(values(cron('10-30/10 * * * *').minute), [10, 20, 30]);
  assert.deepEqual(values(cron('5/25 * * * *').minute), [5, 30, 55]);
});

test('month and weekday names work, and 7 is Sunday', () => {
  assert.deepEqual(values(cron('0 0 * jan,JUL *').month), [1, 7]);
  assert.deepEqual(values(cron('0 0 * * mon-fri').weekday), [1, 2, 3, 4, 5]);
  assert.deepEqual(values(cron('0 0 * * 7').weekday), [0]);
});

test('extra spaces are tolerated and the expression is normalised', () => {
  assert.equal(cron('  0   21 * *  * ').expression, '0 21 * * *');
});

test('a malformed expression is rejected with a reason', () => {
  for (const bad of ['', '0 21 * *', '0 21 * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *',
    '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1,,2 * * * *',
    '1-2-3 * * * *', '*/5/2 * * * *', '-1 * * * *']) {
    const parsed = parseCron(bad);
    assert.equal(parsed.ok, false, `"${bad}" must be rejected`);
    assert.ok(parsed.error.length > 0);
  }
  assert.equal(parseCron('0 '.repeat(60)).ok, false);
});

test('nextRun finds the next matching minute, strictly after the start', () => {
  const daily = cron('0 21 * * *');
  assert.deepEqual(nextRun(daily, at(2026, 9, 4, 10, 30)), at(2026, 9, 4, 21, 0));
  assert.deepEqual(nextRun(daily, at(2026, 9, 4, 21, 0)), at(2026, 9, 5, 21, 0));
  assert.deepEqual(nextRun(daily, at(2026, 9, 4, 21, 0, 30)), at(2026, 9, 5, 21, 0));
  assert.deepEqual(nextRun(cron('* * * * *'), at(2026, 9, 4, 10, 30, 15)), at(2026, 9, 4, 10, 31));
  assert.deepEqual(nextRun(cron('*/15 * * * *'), at(2026, 9, 4, 10, 46)), at(2026, 9, 4, 11, 0));
});

test('nextRun crosses month and year ends', () => {
  assert.deepEqual(nextRun(cron('30 8 1 * *'), at(2026, 9, 4)), at(2026, 10, 1, 8, 30));
  assert.deepEqual(nextRun(cron('0 0 1 1 *'), at(2026, 9, 4)), at(2027, 0, 1, 0, 0));
  assert.deepEqual(nextRun(cron('0 0 29 2 *'), at(2026, 9, 4)), at(2028, 1, 29, 0, 0));
});

test('nextRun honours weekdays, and treats day of month plus weekday as either', () => {
  // October 4, 2026 is a Sunday.
  assert.deepEqual(nextRun(cron('0 9 * * mon-fri'), at(2026, 9, 4, 12)), at(2026, 9, 5, 9, 0));
  assert.deepEqual(nextRun(cron('0 9 15 * mon'), at(2026, 9, 5, 12)), at(2026, 9, 12, 9, 0));
  assert.deepEqual(nextRun(cron('0 9 15 * mon'), at(2026, 9, 13, 12)), at(2026, 9, 15, 9, 0));
});

test('nextRun gives up on a date that never comes', () => {
  assert.equal(nextRun(cron('0 0 30 2 *'), at(2026, 9, 4)), null);
});

test('describeCron reads as a sentence', () => {
  const cases = {
    '* * * * *': 'Every minute',
    '*/5 * * * *': 'Every 5 minutes',
    '0 * * * *': 'Every hour, on the hour',
    '15 * * * *': 'Every hour, at minute 15',
    '0 21 * * *': 'At 21:00 every day',
    '30 8,20 * * *': 'At 08:30 and 20:30 every day',
    '0 8,12,21 * * *': 'At 08:00, 12:00, and 21:00 every day',
    '0 9 * * mon-fri': 'At 09:00 on Monday through Friday',
    '0 9 * * 1,3': 'At 09:00 on Monday and Wednesday',
    '0 9 1 * *': 'At 09:00 on day 1 of the month',
    '0 9 1,15 * *': 'At 09:00 on days 1 and 15 of the month',
    '0 9 1 * mon': 'At 09:00 on day 1 of the month or on Monday',
    '0 9 * jan,jul *': 'At 09:00 in January and July',
    '*/10 9-17 * * *': 'Every 10 minutes, between 09:00 and 17:59',
    '0 */2 * * *': 'At minute 0 of the hour, every 2 hours',
    '* 9 * * *': 'Every minute, during hour 9',
    '0,30 * * * *': 'At minutes 0 and 30 of the hour',
    '*/10 9-17 * * mon-fri': 'Every 10 minutes, between 09:00 and 17:59 on Monday through Friday',
  };
  for (const [expression, text] of Object.entries(cases)) {
    assert.equal(describeCron(cron(expression)), text, expression);
  }
});

test('scheduleOf is the parsed schedule only when it is on and valid', () => {
  assert.equal(scheduleOf({ schedule: { enabled: true, cron: '0 21 * * *' } }).expression, '0 21 * * *');
  assert.equal(scheduleOf({ schedule: { enabled: false, cron: '0 21 * * *' } }), null);
  assert.equal(scheduleOf({ schedule: { enabled: true, cron: 'nonsense' } }), null);
  assert.equal(scheduleOf({ schedule: { enabled: 'yes', cron: '0 21 * * *' } }), null);
  assert.equal(scheduleOf({}), null);
  assert.equal(scheduleOf(undefined), null);
});

test('sanitizeSchedule keeps the text and turns an invalid schedule off', () => {
  assert.deepEqual(sanitizeSchedule({ enabled: true, cron: ' 0  21 * * * ' }), { enabled: true, cron: '0 21 * * *' });
  assert.deepEqual(sanitizeSchedule({ enabled: true, cron: 'nonsense' }), { enabled: false, cron: 'nonsense' });
  assert.deepEqual(sanitizeSchedule({ enabled: 'yes', cron: '0 21 * * *' }), { enabled: false, cron: '0 21 * * *' });
  assert.deepEqual(sanitizeSchedule(undefined), { enabled: false, cron: '' });
});

test('cronAlarmNeedsReset keeps an alarm that is right or about to fire', () => {
  const now = 1_000_000;
  assert.equal(cronAlarmNeedsReset(null, now + 60_000, now), true);
  assert.equal(cronAlarmNeedsReset({ scheduledTime: now + 60_000 }, now + 60_000, now), false);
  assert.equal(cronAlarmNeedsReset({ scheduledTime: now + 60_000.4 }, now + 60_000, now), false);
  assert.equal(cronAlarmNeedsReset({ scheduledTime: now + 120_000 }, now + 60_000, now), true);
  assert.equal(cronAlarmNeedsReset({ scheduledTime: now - 5 }, now + 60_000, now), false);
});

test('missedRun is true only when a scheduled time passed since the last run', () => {
  const daily = cron('0 21 * * *');
  const last = at(2026, 9, 3, 21, 0, 5).toISOString();
  assert.equal(missedRun(daily, last, at(2026, 9, 4, 20, 0)), false);
  assert.equal(missedRun(daily, last, at(2026, 9, 4, 21, 30)), true);
  assert.equal(missedRun(daily, undefined, at(2026, 9, 4, 21, 30)), false);
  assert.equal(missedRun(daily, 'not a date', at(2026, 9, 4, 21, 30)), false);
});
