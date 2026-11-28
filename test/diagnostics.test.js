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
  describeReads,
  diagnosticsFilename,
  folderRef,
  formatEntry,
  formatLocalTime,
  makeEntry,
  revealText,
  ruleRef,
  sensitive,
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
        { field: 'from', operator: 'nameShowsOtherAddress' },
        { field: 'read', operator: 'isOff' },
        { field: 'priority', operator: 'priorityIs', value: 'high', negate: true },
        { field: 'tag', operator: 'hasTag', tagKey: 'Secret tag', negate: true },
        { field: 'auth', operator: 'authPasses', value: 'dkim', negate: true },
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
  offsetMinutes: 0,
};

test('the default report carries no addresses, domains, patterns, or folders', () => {
  const report = buildReport(base);
  for (const secret of ['spammer', 'evil.example', 'bad.example', 'Junk"', 'account1://', 'Archive', 'Family secrets', 'Secret tag']) {
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
  assert.match(report, /from name shows a different address/);
  assert.match(report, /if is unread/);
  assert.match(report, /priority is not high/);
  assert.match(report, /dkim does not pass/);
  assert.match(report, /not has tag/);
  assert.match(report, /age older than 30 day/);
  assert.match(report, /last run: 2026-09-11 08:28:00 \+00:00; last catch-up: 2026-09-11 08:10:00 \+00:00/);
  assert.match(report, /incremental scan, 3 scanned/);
});

test('opting in includes the values', () => {
  const report = buildReport({ ...base, includeValues: true });
  assert.ok(report.includes('info@spammer'));
  assert.ok(report.includes('evil.example'));
  assert.ok(report.includes('account1://Junk'));
  assert.ok(report.includes('Family secrets'));
  assert.ok(report.includes('not has tag Secret tag'));
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
  assert.equal(formatEntry({ t: '2026-10-15T21:38:36.000Z', level: 'info', msg: 'm' }, -120), '2026-10-15 23:38:36 +02:00 info m');
  assert.equal(describeAction({ type: 'tag', tagKey: '$label1' }), 'tag -> (tag)');
  assert.equal(describeAction({ type: 'tag', tagKey: '$label1' }, { includeValues: true }), 'tag -> $label1');
  assert.equal(describeAction({ type: 'removeTag', tagKey: '$label1' }), 'removeTag -> (tag)');
  assert.equal(describeAction({ type: 'removeTag', tagKey: '$label1' }, { includeValues: true }), 'removeTag -> $label1');
  assert.equal(describeAction({ type: 'clearTags' }), 'clearTags');
  assert.equal(describeAction({ type: 'markRead' }), 'markRead');
  assert.equal(describeCondition({ field: 'size', operator: 'largerThan', size: 5, unit: 'MB' }), 'size larger than 5 MB');
  assert.equal(describeCondition({ field: 'size', operator: 'smallerThan', size: 500, unit: 'KB', negate: true }), 'size not smaller than 500 KB');
  assert.equal(describeCondition({ field: 'to-cc', operator: 'contains', value: 'secret@example.com' }), 'to-cc contains <18 chars>');
  assert.equal(describeCondition({ field: 'x-spam-status', operator: 'contains', value: 'Yes' }), 'x-spam-status contains <3 chars>');
  assert.equal(describeCondition({ field: 'x-spam-status', operator: 'contains', value: 'Yes' }, { includeValues: true }), 'x-spam-status contains "Yes"');
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

test('the report says when a rule includes subfolders', () => {
  const withSubs = { ...config, rules: [{ ...config.rules[0], includeSubfolders: true }] };
  assert.match(buildReport({ ...base, config: withSubs }), /folders: 1 and their subfolders/);
  assert.match(buildReport(base), /folders: 1\n/);
});

test('the report says whether the right-click menu is shown', () => {
  assert.match(buildReport(base), /right-click menu: shown; name: full/);
  assert.match(
    buildReport({ ...base, config: { ...config, advanced: { shortName: true } } }),
    /right-click menu: shown; name: FFS/,
  );
  assert.match(
    buildReport({ ...base, config: { ...config, advanced: { showMenu: false } } }),
    /right-click menu: hidden/,
  );
});

test('the report shows a rule\'s own schedule', () => {
  const withRule = (schedule) => ({ ...config, rules: [{ ...config.rules[0], schedule }] });
  assert.match(
    buildReport({ ...base, config: withRule({ enabled: true, cron: '0 21 * * *' }) }),
    /schedule: cron 0 21 \* \* \*; next run: \d{4}-/,
  );
  assert.match(buildReport(base), /rule schedule runs in the log: only those that change mail or fail/);
  assert.match(
    buildReport({ ...base, config: { ...config, advanced: { logScheduleRuns: true } } }),
    /rule schedule runs in the log: all/,
  );
  assert.match(
    buildReport({ ...base, config: withRule({ enabled: true, cron: 'nonsense' }) }),
    /schedule: invalid cron/,
  );
  assert.doesNotMatch(buildReport({ ...base, config: withRule({ enabled: false, cron: '0 21 * * *' }) }), /schedule:/);
  assert.doesNotMatch(buildReport(base), /schedule:/);
});

test('formatLocalTime shows local time with the UTC offset (#28)', () => {
  const t = '2026-10-15T21:38:36.000Z';
  assert.equal(formatLocalTime(t, 0), '2026-10-15 21:38:36 +00:00');
  assert.equal(formatLocalTime(t, -120), '2026-10-15 23:38:36 +02:00');
  assert.equal(formatLocalTime(t, 240), '2026-10-15 17:38:36 -04:00');
  assert.equal(formatLocalTime(t, -330), '2026-10-16 03:08:36 +05:30');
  assert.equal(formatLocalTime(new Date(t), -60), '2026-10-15 22:38:36 +01:00');
  assert.equal(formatLocalTime('not a date', 0), 'not a date');
  assert.equal(formatLocalTime(undefined, 0), '?');
});

test('the report shows the authentication settings and hides the trusted servers', () => {
  const plain = buildReport(base);
  assert.match(plain, /own DKIM check: on, DNS server cloudflare \(not granted\)/);
  assert.match(plain, /when the checks disagree: use the own result/);
  assert.match(plain, /trusted authentication servers: none set, the topmost header is trusted/);

  const advanced = { authOwnCheck: true, authDohServer: 'google', authPrefer: 'provider', authTrustedServers: 'mta.yahoo.com' };
  const input = { ...base, config: { ...config, advanced }, permissions: { ...base.permissions, dnsServer: true } };
  const report = buildReport(input);
  assert.match(report, /own DKIM check: on, DNS server google \(granted\)/);
  assert.match(report, /when the checks disagree: use the provider's header/);
  assert.match(report, /trusted authentication servers: 1 set/);
  assert.ok(!report.includes('mta.yahoo.com'));
  assert.match(buildReport({ ...input, includeValues: true }), /trusted authentication servers: mta.yahoo.com/);

  const off = buildReport({ ...base, config: { ...config, advanced: { authOwnCheck: false } } });
  assert.match(off, /own DKIM check: off/);
});

test('the report shows stopProcessing and last run outcome when present', () => {
  const report = buildReport({
    ...base,
    config: {
      ...config,
      rules: [{ ...config.rules[0], stopProcessing: true }],
    },
    runState: {
      'aaaaaaaa-1111': {
        ...runState['aaaaaaaa-1111'],
        lastStatus: { at: now.toISOString(), scanned: 50, matched: 4, affected: 3, error: true },
      },
    },
  });
  assert.match(report, /stop later rules: yes/);
  assert.match(report, /last outcome: 4 matched, 3 actioned \(with errors\)/);
});

// A rule made from a message is named after its sender or its subject, so a
// rule name is a value like an address.
const namedRule = { id: 'bbbbbbbb-2222', name: 'boss@example.com "urgent"', enabled: true, conditions: [], actions: [] };
const namedConfig = { ...config, rules: [...config.rules, namedRule] };

test('the default report replaces each rule name with its position and id', () => {
  const report = buildReport({ ...base, config: namedConfig });
  assert.ok(!report.includes('Junk cleanup'), 'leaked a rule name');
  assert.ok(!report.includes('boss@example.com'), 'leaked a rule name');
  assert.match(report, /- rule 1 \[enabled\] id aaaaaaaa\n/);
  assert.match(report, /- rule 2 \[enabled\] id bbbbbbbb\n/);
  assert.match(report, /folders and rule names are hidden/);
  // The log line of the rule carries the same id, so the two still link.
  assert.match(report, /info rule \[aaaaaaaa\]: incremental scan, 3 scanned/);

  const withValues = buildReport({ ...base, config: namedConfig, includeValues: true });
  assert.match(withValues, /- "Junk cleanup" \[enabled\] id aaaaaaaa/);
  assert.match(withValues, /info rule "Junk cleanup": incremental scan, 3 scanned/);
});

test('a marked log line hides the rule name and the folder, also for a deleted rule', () => {
  const gone = { id: 'cccccccc-3333', name: 'From alice@example.com' };
  const line = `scan failed for folder ${folderRef('account1://INBOX/Clients/Acme')} in rule ${ruleRef(gone)}`;
  const entry = makeEntry('warn', [line, new Error('offline')], now);

  const hidden = formatEntry(entry, 0, { rules: config.rules });
  assert.equal(hidden, '2026-09-11 08:30:00 +00:00 WARN scan failed for folder (folder) in rule [cccccccc] Error: offline');
  const shown = formatEntry(entry, 0, { includeValues: true });
  assert.match(shown, /for folder account1:\/\/INBOX\/Clients\/Acme in rule "From alice@example\.com" Error: offline$/);

  assert.equal(revealText(`dry run ${ruleRef({ name: 'Draft' })}: 3 scanned`, false), 'dry run [not saved]: 3 scanned');
  // The marks never reach the console or a report.
  assert.doesNotMatch(shown + hidden, /[\uE000-\uE002]/);
});

test('a mark inside a name cannot end the hidden part early', () => {
  const tricky = { id: 'dddddddd', name: 'a\uE002 secret@example.com' };
  assert.equal(revealText(`rule ${ruleRef(tricky)}: done`, false), 'rule [dddddddd]: done');
  assert.equal(revealText(sensitive('x', 'y\uE000z'), false), 'yz');
});

test('a line cut inside a hidden part stays hidden', () => {
  const long = { id: 'eeeeeeee', name: 'n'.repeat(600) };
  const entry = makeEntry('info', [`rule ${ruleRef(long)}: full scan`], now);
  const hidden = formatEntry(entry, 0);
  assert.ok(!hidden.includes('nnn'), 'leaked a cut rule name');
  assert.match(hidden, /info rule \(hidden\)$/);
});

test('a line written before the marks existed hides names and folders too', () => {
  const old = (msg) => formatEntry({ t: now.toISOString(), level: 'info', msg }, 0, { rules: namedConfig.rules });
  // A known rule keeps its link to the rule list.
  assert.match(old('rule "Junk cleanup": incremental scan, 3 scanned'), /info rule \[aaaaaaaa\]: incremental scan, 3 scanned$/);
  assert.match(old('action failed for rule "boss@example.com "urgent"" Error: x'), /for rule \[bbbbbbbb\] Error: x$/);
  // A renamed or deleted rule has no id to show.
  const lost = old('scan failed for folder account1://Clients/Acme Corp in rule "From carol@example.com" Error: x');
  assert.ok(!lost.includes('carol') && !lost.includes('Acme'), lost);
  assert.match(lost, /scan failed for folder \(folder\) in rule \[name hidden\]/);
  assert.ok(!old('dry run "Re: salary "2026"": 4 scanned').includes('salary'));
  assert.ok(!old('copy destination lookup failed for folder account1://Private/Tax Error: x').includes('Tax'));
  // With values, an old line is printed as it was written.
  const shown = formatEntry({ t: now.toISOString(), level: 'info', msg: 'rule "Junk cleanup": done' }, 0, { includeValues: true });
  assert.match(shown, /rule "Junk cleanup": done$/);
});

test('describeReads sums up the reads of a run, and is empty without reads', () => {
  assert.equal(describeReads('header reads', null), '');
  assert.equal(describeReads('header reads', { fresh: 0, cached: 0, timeouts: 0, skipped: 0, spentMs: 0 }), '');
  assert.equal(
    describeReads('header reads', { fresh: 120, cached: 30, timeouts: 0, skipped: 0, spentMs: 4312.4, slowestMs: 911 }),
    '; header reads: 120 in 4312 ms, slowest 911 ms, 30 from cache',
  );
  assert.equal(
    describeReads('body reads', { fresh: 0, cached: 0, timeouts: 2, skipped: 40, spentMs: 14000, slowestMs: 0, budgetReached: true }),
    '; body reads: 0 in 14000 ms, 2 with no answer, 40 skipped, time budget reached',
  );
});
