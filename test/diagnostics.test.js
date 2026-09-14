/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_CAP,
  appendEntries,
  buildReport,
  describeAction,
  describeCondition,
  diagnosticsFilename,
  formatEntry,
  makeEntry,
} from '../src/diagnostics.js';

const now = new Date('2026-09-11T08:30:00Z');

test('makeEntry flattens errors and objects and caps length', () => {
  const e = makeEntry('warn', ['scan failed', new TypeError('boom'), { a: 1 }], now);
  assert.equal(e.level, 'warn');
  assert.equal(e.t, now.toISOString());
  assert.equal(e.msg, 'scan failed TypeError: boom {"a":1}');
  assert.ok(makeEntry('info', ['x'.repeat(2000)], now).msg.length <= 501);
});

test('appendEntries keeps only the newest entries and never mutates', () => {
  const existing = Array.from({ length: LOG_CAP }, (_, i) => ({ t: '', level: 'info', msg: `old ${i}` }));
  const out = appendEntries(existing, [{ t: '', level: 'info', msg: 'new' }]);
  assert.equal(out.length, LOG_CAP);
  assert.equal(out.at(-1).msg, 'new');
  assert.equal(out[0].msg, 'old 1');
  assert.equal(existing.length, LOG_CAP);
  assert.deepEqual(appendEntries(undefined, [], 5), []);
});

const config = {
  intervalMinutes: 2,
  advanced: { runOnNewMail: true, newMailDelaySeconds: 10, scanOverlapMinutes: 90, catchUpEveryMinutes: 30, catchUpLookbackDays: 30 },
  allowlist: ['gmail.com'],
  rules: [
    {
      id: 'aaaaaaaa-1111',
      name: 'Junk cleanup',
      enabled: true,
      match: 'any',
      folderIds: ['account1://Junk'],
      conditions: [
        { field: 'from', operator: 'matchesRegex', value: 'info@spammer\\.example' },
        { fields: ['reply-to', 'from'], operator: 'domainInList', domains: ['evil.example', 'bad.example'] },
        { field: 'from', operator: 'inAddressBook', addressBookId: 'all', negate: true },
        { field: 'age', operator: 'olderThan', days: 30 },
      ],
      actions: [{ type: 'tag', tagKey: 'Family secrets' }, { type: 'move', folderId: 'account1://Archive' }],
    },
  ],
};
const runState = { 'aaaaaaaa-1111': { lastRunAt: '2026-09-11T08:28:00.000Z', lastCatchUpAt: '2026-09-11T08:10:00.000Z' } };
const entries = [makeEntry('info', ['rule "Junk cleanup": incremental scan, 3 scanned'], now)];

const base = {
  version: '0.3.1',
  browser: { name: 'Thunderbird', version: '152.0' },
  platform: { os: 'mac', arch: 'aarch64' },
  config,
  runState,
  alarm: { scheduledTime: now.getTime() + 60_000 },
  permissions: { addressBooks: true, messagesTagsList: false },
  entries,
  generatedAt: now,
};

test('the default report carries no addresses, domains, patterns, or folders', () => {
  const report = buildReport(base);
  for (const secret of ['spammer', 'evil.example', 'bad.example', 'Junk"', 'account1://', 'Archive', 'Family secrets']) {
    assert.ok(!report.includes(secret), `leaked ${secret}`);
  }
  assert.match(report, /Thunderbird 152\.0/);
  assert.match(report, /extension: 0\.3\.1/);
  assert.match(report, /interval: every 2 min/);
  assert.match(report, /address book access: granted/);
  assert.match(report, /tag list access: not granted/);
  assert.match(report, /run on new mail: yes, 10s after the last arrival/);
  assert.match(report, /scan overlap: 90 min/);
  assert.match(report, /catch-up: every 30 min over the last 30 day\(s\)/);
  // Actions in execution order: the move consumes the message, so it is last.
  assert.match(report, /then: tag -> \(tag\)\n\s+then: move -> \(folder\)/);
  assert.match(report, /from matchesRegex <\d+ chars>/);
  assert.match(report, /domain in list of 2/);
  assert.match(report, /from not in address book \(all\)/);
  assert.match(report, /age older than 30 day/);
  assert.match(report, /last run: 2026-09-11T08:28:00\.000Z; last catch-up: 2026-09-11T08:10:00\.000Z/);
  assert.match(report, /incremental scan, 3 scanned/);
});

test('opting in includes the values', () => {
  const report = buildReport({ ...base, includeValues: true });
  assert.ok(report.includes('info@spammer'));
  assert.ok(report.includes('evil.example'));
  assert.ok(report.includes('account1://Junk'));
  assert.ok(report.includes('Family secrets'));
  assert.match(report, /values included: yes/);
});

test('buildReport survives missing everything', () => {
  const report = buildReport({ config: null, runState: null, entries: [] });
  assert.match(report, /rules \(0\)/);
  assert.match(report, /next scheduled run: none scheduled/);
  // A config written before 0.3.2 has no advanced block; the defaults stand in.
  assert.match(report, /run on new mail: yes, 10s after the last arrival/);
});

test('the report shows the advanced settings actually in force', () => {
  const report = buildReport({
    ...base,
    config: { ...config, advanced: { runOnNewMail: false, catchUpEveryMinutes: 120, catchUpLookbackDays: 7 } },
  });
  assert.match(report, /run on new mail: no/);
  assert.match(report, /catch-up: every 120 min over the last 7 day\(s\)/);
});

test('describeCondition and formatEntry read as plain text', () => {
  assert.equal(describeCondition({ field: 'subject', operator: 'contains', value: 'abc' }), 'subject contains <3 chars>');
  assert.equal(formatEntry({ t: 'T', level: 'warn', msg: 'm' }), 'T WARN m');
  assert.equal(describeAction({ type: 'tag', tagKey: '$label1' }), 'tag -> (tag)');
  assert.equal(describeAction({ type: 'tag', tagKey: '$label1' }, { includeValues: true }), 'tag -> $label1');
  assert.equal(describeAction({ type: 'markRead' }), 'markRead');
});

test('a pre-0.3.2 single-action rule still shows its action', () => {
  const report = buildReport({
    ...base,
    config: { ...config, rules: [{ id: 'x', name: 'Old', action: { type: 'trash' } }] },
  });
  assert.match(report, /then: trash/);
});

test('diagnosticsFilename is timestamped like rule exports', () => {
  assert.equal(diagnosticsFilename(new Date(2026, 8, 11, 9, 5)), 'ffs-diagnostics-2026-09-11-0905.txt');
});
