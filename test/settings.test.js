/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADVANCED_DEFAULTS, ADVANCED_LIMITS, isDefaultAdvanced, sanitizeAdvanced } from '../src/settings.js';

test('nothing stored yields the defaults, with nothing to report', () => {
  for (const input of [undefined, null, {}]) {
    const { settings, problems } = sanitizeAdvanced(input);
    assert.deepEqual(settings, { ...ADVANCED_DEFAULTS });
    assert.deepEqual(problems, []);
  }
});

test('the new-mail trigger is on unless it was explicitly turned off', () => {
  assert.equal(sanitizeAdvanced({ runOnNewMail: false }).settings.runOnNewMail, false);
  assert.equal(sanitizeAdvanced({ runOnNewMail: true }).settings.runOnNewMail, true);
  assert.equal(sanitizeAdvanced({}).settings.runOnNewMail, true);
});

test('values are clamped to their range and the clamp is reported', () => {
  const { settings, problems } = sanitizeAdvanced({
    newMailDelaySeconds: 600,
    catchUpEveryMinutes: 0,
    catchUpLookbackDays: 99999,
    scanOverlapMinutes: -5,
  });
  assert.equal(settings.newMailDelaySeconds, ADVANCED_LIMITS.newMailDelaySeconds.max);
  assert.equal(settings.catchUpEveryMinutes, ADVANCED_LIMITS.catchUpEveryMinutes.min);
  assert.equal(settings.catchUpLookbackDays, ADVANCED_LIMITS.catchUpLookbackDays.max);
  assert.equal(settings.scanOverlapMinutes, ADVANCED_LIMITS.scanOverlapMinutes.min);
  assert.equal(problems.length, 4);
});

test('the new-mail delay cannot exceed 15 seconds', () => {
  // Longer than this races the event page being suspended, which would drop the
  // run entirely. See the comment on ADVANCED_LIMITS.
  assert.equal(ADVANCED_LIMITS.newMailDelaySeconds.max, 15);
  assert.equal(sanitizeAdvanced({ newMailDelaySeconds: 60 }).settings.newMailDelaySeconds, 15);
});

test('an overlap of zero is allowed; a catch-up interval of zero is not', () => {
  // Zero overlap is a real choice. A zero catch-up interval would make every
  // single run a 30-day scan.
  assert.deepEqual(sanitizeAdvanced({ scanOverlapMinutes: 0 }).problems, []);
  assert.equal(sanitizeAdvanced({ scanOverlapMinutes: 0 }).settings.scanOverlapMinutes, 0);
  assert.equal(sanitizeAdvanced({ catchUpEveryMinutes: 0 }).settings.catchUpEveryMinutes, 1);
});

test('junk and empty input fall back to the defaults', () => {
  const junk = sanitizeAdvanced({ catchUpEveryMinutes: 'soon', newMailDelaySeconds: {} });
  assert.equal(junk.settings.catchUpEveryMinutes, ADVANCED_DEFAULTS.catchUpEveryMinutes);
  assert.equal(junk.settings.newMailDelaySeconds, ADVANCED_DEFAULTS.newMailDelaySeconds);
  assert.equal(junk.problems.length, 2);

  // An empty input box is "not set", not "wrong", so it is silent.
  const blank = sanitizeAdvanced({ catchUpEveryMinutes: '' });
  assert.equal(blank.settings.catchUpEveryMinutes, ADVANCED_DEFAULTS.catchUpEveryMinutes);
  assert.deepEqual(blank.problems, []);
});

test('numeric strings and fractions become whole numbers', () => {
  assert.equal(sanitizeAdvanced({ catchUpEveryMinutes: '45' }).settings.catchUpEveryMinutes, 45);
  assert.equal(sanitizeAdvanced({ catchUpEveryMinutes: 45.9 }).settings.catchUpEveryMinutes, 45);
});

test('isDefaultAdvanced recognises an untouched configuration', () => {
  assert.equal(isDefaultAdvanced(sanitizeAdvanced({}).settings), true);
  assert.equal(isDefaultAdvanced(sanitizeAdvanced({ catchUpEveryMinutes: 45 }).settings), false);
  assert.equal(isDefaultAdvanced(undefined), false);
});

// --- Schedule alarm (#12) -----------------------------------------------------

import { alarmNeedsReset } from '../src/settings.js';

test('a running alarm with the same period is kept, so a wake does not restart it', () => {
  assert.equal(alarmNeedsReset({ name: 'tick', periodInMinutes: 10 }, 10), false);
});

test('a missing alarm or a changed period is re-created', () => {
  assert.equal(alarmNeedsReset(null, 10), true);
  assert.equal(alarmNeedsReset(undefined, 10), true);
  assert.equal(alarmNeedsReset({ name: 'tick', periodInMinutes: 5 }, 10), true);
});
