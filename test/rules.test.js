/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_FORMAT, buildExport, exportFilename, ruleFingerprint, ruleHash, sanitizeImport } from '../src/rules.js';

const validRule = {
  name: 'Spam domains',
  enabled: true,
  match: 'any',
  folderIds: ['junk'],
  conditions: [{ fields: ['reply-to', 'from'], operator: 'domainInList', domains: ['evil.com'] }],
  action: { type: 'trash' },
};

const file = (overrides = {}) => ({
  format: EXPORT_FORMAT,
  version: 1,
  intervalMinutes: 10,
  rules: [validRule],
  ...overrides,
});

test('a round trip preserves a valid rule', () => {
  const exported = buildExport({ intervalMinutes: 10, rules: [validRule], allowlist: ['gmail.com'] });
  const { rules, problems } = sanitizeImport(exported);
  assert.deepEqual(problems, []);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].conditions[0].fields, ['reply-to', 'from']);
  assert.deepEqual(rules[0].conditions[0].domains, ['evil.com']);
  // The pre-0.3.2 single-action shape is read back as a one-entry list.
  assert.deepEqual(rules[0].actions, [{ type: 'trash' }]);
});

test('multiple actions survive a round trip, terminal action last', () => {
  const rule = {
    ...validRule,
    action: undefined,
    actions: [{ type: 'move', folderId: 'friends' }, { type: 'tag', tagKey: '$label1' }],
  };
  const { rules, problems } = sanitizeImport(buildExport({ rules: [rule] }));
  assert.deepEqual(problems, []);
  assert.deepEqual(rules[0].actions, [
    { type: 'tag', tagKey: '$label1' },
    { type: 'move', folderId: 'friends' },
  ]);
});

test('only one action that consumes the message is kept', () => {
  const { rules, problems } = sanitizeImport(
    file({
      rules: [{
        ...validRule,
        action: undefined,
        actions: [{ type: 'trash' }, { type: 'deletePermanently' }, { type: 'markRead' }],
      }],
    }),
  );
  assert.deepEqual(rules[0].actions, [{ type: 'markRead' }, { type: 'trash' }]);
  assert.ok(problems.some((p) => /only end in one action/.test(p)));
});

test('a tag action without a tag is dropped', () => {
  const { rules, problems } = sanitizeImport(
    file({ rules: [{ ...validRule, action: undefined, actions: [{ type: 'tag' }, { type: 'trash' }] }] }),
  );
  assert.deepEqual(rules[0].actions, [{ type: 'trash' }]);
  assert.ok(problems.some((p) => /needs a tag/.test(p)));
});

test('a rule left with no usable action is skipped entirely', () => {
  const { rules, problems } = sanitizeImport(
    file({ rules: [{ ...validRule, action: undefined, actions: [{ type: 'tag' }] }] }),
  );
  assert.deepEqual(rules, []);
  assert.ok(problems.some((p) => /no usable action/.test(p)));
});

test('export never includes run state or rule ids', () => {
  const exported = buildExport({ rules: [{ ...validRule, id: 'abc', lastRunAt: 'x' }] });
  assert.equal('id' in exported.rules[0], false);
  assert.equal('lastRunAt' in exported.rules[0], false);
});

test('imported rules get no id, so fresh ones are assigned on save', () => {
  const { rules } = sanitizeImport(file({ rules: [{ ...validRule, id: 'stale-id' }] }));
  assert.equal(rules[0].id, undefined);
});

test('a domainInList condition with an empty list is rejected', () => {
  // Importing a blank list must not produce a rule that matches everything.
  const { rules, problems } = sanitizeImport(
    file({ rules: [{ ...validRule, conditions: [{ field: 'from', operator: 'domainInList', domains: [] }] }] }),
  );
  assert.deepEqual(rules, []);
  assert.ok(problems.some((p) => /domain list is empty/.test(p)));
});

test('invalid domains are stripped from an imported list', () => {
  const { rules, problems } = sanitizeImport(
    file({
      rules: [{
        ...validRule,
        conditions: [{ field: 'from', operator: 'domainInList', domains: ['evil.com', '', 'nonsense'] }],
      }],
    }),
  );
  assert.deepEqual(rules[0].conditions[0].domains, ['evil.com']);
  assert.ok(problems.some((p) => /invalid domain/.test(p)));
});

test('an unknown action is refused rather than imported', () => {
  const { rules, problems } = sanitizeImport(
    file({ rules: [{ ...validRule, action: { type: 'launchMissiles' } }] }),
  );
  assert.deepEqual(rules, []);
  assert.ok(problems.some((p) => /unknown action/.test(p)));
});

test('a folder-requiring action without a folder is refused', () => {
  const { rules } = sanitizeImport(file({ rules: [{ ...validRule, action: { type: 'move' } }] }));
  assert.deepEqual(rules, []);
});

test('the fingerprint ignores the order actions were written in', () => {
  const a = { ...validRule, action: undefined, actions: [{ type: 'tag', tagKey: '$label1' }, { type: 'trash' }] };
  const b = { ...validRule, action: undefined, actions: [{ type: 'trash' }, { type: 'tag', tagKey: '$label1' }] };
  assert.equal(ruleFingerprint(a), ruleFingerprint(b));
  assert.notEqual(
    ruleFingerprint(a),
    ruleFingerprint({ ...a, actions: [{ type: 'tag', tagKey: '$label2' }, { type: 'trash' }] }),
  );
});

test('a single-action rule and its list form fingerprint identically', () => {
  assert.equal(
    ruleFingerprint(validRule),
    ruleFingerprint({ ...validRule, action: undefined, actions: [{ type: 'trash' }] }),
  );
});

test('an unknown operator or header field drops the condition', () => {
  const { rules, problems } = sanitizeImport(
    file({ rules: [{ ...validRule, conditions: [{ field: 'from', operator: 'sudo', value: 'x' }] }] }),
  );
  assert.deepEqual(rules, []);
  assert.ok(problems.some((p) => /unknown operator/.test(p)));

  const bogusField = sanitizeImport(
    file({ rules: [{ ...validRule, conditions: [{ field: 'x-evil', operator: 'contains', value: 'x' }] }] }),
  );
  assert.deepEqual(bogusField.rules, []);
  assert.ok(bogusField.problems.some((p) => /no recognised header field/.test(p)));
});

test('an empty value on a string operator is refused', () => {
  // endsWith "" matches every message; it must not survive an import.
  const { rules, problems } = sanitizeImport(
    file({ rules: [{ ...validRule, conditions: [{ field: 'from', operator: 'endsWith', value: '' }] }] }),
  );
  assert.deepEqual(rules, []);
  assert.ok(problems.some((p) => /empty value/.test(p)));
});

test('folders missing from this profile are removed and reported', () => {
  const { rules, problems } = sanitizeImport(file(), { knownFolderIds: ['inbox'] });
  assert.deepEqual(rules[0].folderIds, []);
  assert.ok(problems.some((p) => /not in this profile/.test(p)));
});

test('junk input is rejected without throwing', () => {
  for (const bad of [null, 42, 'nope', {}, { rules: 'no' }]) {
    const { rules, problems } = sanitizeImport(bad);
    assert.deepEqual(rules, []);
    assert.ok(problems.length > 0);
  }
});

test('a foreign format is flagged but still parsed if it has rules', () => {
  const { rules, problems } = sanitizeImport(file({ format: 'something/else' }));
  assert.equal(rules.length, 1);
  assert.ok(problems.some((p) => /Unexpected format/.test(p)));
});

test('interval and allowlist are validated', () => {
  const ok = sanitizeImport(file({ intervalMinutes: 15, allowlist: ['gmail.com', 'junk'] }));
  assert.equal(ok.intervalMinutes, 15);
  assert.deepEqual(ok.allowlist, ['gmail.com']);
  assert.equal(sanitizeImport(file({ intervalMinutes: 0 })).intervalMinutes, null);
});

// --- fingerprinting and duplicate detection --------------------------------

test('the fingerprint ignores name and enabled state', () => {
  const a = ruleFingerprint(validRule);
  const b = ruleFingerprint({ ...validRule, name: 'Totally different', enabled: false });
  assert.equal(a, b);
});

test('the fingerprint ignores the order of folders, conditions, and domains', () => {
  const reordered = {
    ...validRule,
    folderIds: ['junk', 'inbox'],
    conditions: [
      { field: 'subject', operator: 'contains', value: 'sale' },
      { fields: ['from', 'reply-to'], operator: 'domainInList', domains: ['b.com', 'a.com'] },
    ],
  };
  const original = {
    ...validRule,
    folderIds: ['inbox', 'junk'],
    conditions: [
      { fields: ['reply-to', 'from'], operator: 'domainInList', domains: ['a.com', 'b.com'] },
      { field: 'subject', operator: 'contains', value: 'sale' },
    ],
  };
  assert.equal(ruleFingerprint(reordered), ruleFingerprint(original));
});

test('the fingerprint changes when behaviour changes', () => {
  const base = ruleFingerprint(validRule);
  assert.notEqual(base, ruleFingerprint({ ...validRule, match: 'all' }));
  assert.notEqual(base, ruleFingerprint({ ...validRule, action: { type: 'deletePermanently' } }));
  assert.notEqual(base, ruleFingerprint({ ...validRule, folderIds: ['other'] }));
  assert.notEqual(
    base,
    ruleFingerprint({
      ...validRule,
      conditions: [{ fields: ['reply-to', 'from'], operator: 'domainInList', domains: ['other.com'] }],
    }),
  );
});

test('ruleHash is a short, stable hex label', () => {
  assert.match(ruleHash(validRule), /^[0-9a-f]{8}$/);
  assert.equal(ruleHash(validRule), ruleHash({ ...validRule, name: 'renamed' }));
});

test('importing a rule that already exists is skipped and reported', () => {
  const { rules, duplicates } = sanitizeImport(file(), { existingRules: [validRule] });
  assert.deepEqual(rules, []);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].matches, 'Spam domains');
  assert.match(duplicates[0].hash, /^[0-9a-f]{8}$/);
});

test('a renamed copy of an existing rule still counts as a duplicate', () => {
  const { rules, duplicates } = sanitizeImport(
    file({ rules: [{ ...validRule, name: 'Spam domains (copy)' }] }),
    { existingRules: [validRule] },
  );
  assert.deepEqual(rules, []);
  assert.equal(duplicates[0].name, 'Spam domains (copy)');
});

test('duplicates within a single file collapse to one import', () => {
  const { rules, duplicates } = sanitizeImport(file({ rules: [validRule, { ...validRule, name: 'again' }] }));
  assert.equal(rules.length, 1);
  assert.equal(duplicates.length, 1);
});

test('a genuinely different rule still imports alongside a duplicate', () => {
  const other = { ...validRule, name: 'Other', folderIds: [], conditions: [{ field: 'subject', operator: 'contains', value: 'sale' }] };
  const { rules, duplicates } = sanitizeImport(file({ rules: [validRule, other] }), {
    existingRules: [validRule],
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].name, 'Other');
  assert.equal(duplicates.length, 1);
});

test('the export filename carries a sortable local date and time', () => {
  const name = exportFilename(new Date(2026, 7, 24, 20, 13));
  assert.equal(name, 'ffs-rules-2026-08-24-2013.json');
  // No characters that are illegal in a filename on Windows.
  assert.equal(/[:*?"<>|]/.test(name), false);
});

test('export filenames sort chronologically as plain strings', () => {
  const earlier = exportFilename(new Date(2026, 7, 24, 9, 5));
  const later = exportFilename(new Date(2026, 7, 24, 20, 13));
  assert.ok(earlier < later);
  assert.ok(exportFilename(new Date(2026, 0, 2, 3, 4)).includes('2026-01-02-0304'));
});

test('the export records when it was written', () => {
  const when = new Date('2026-08-24T18:13:00.000Z');
  assert.equal(buildExport({ rules: [] }, { exportedAt: when }).exportedAt, when.toISOString());
});

// --- Age conditions ---------------------------------------------------------

const ageRule = {
  ...validRule,
  name: 'Archive old alerts',
  match: 'all',
  conditions: [
    { field: 'subject', operator: 'contains', value: 'alert' },
    { field: 'age', operator: 'olderThan', days: 30, negate: false },
  ],
};

test('import accepts an age condition and normalises its day count', () => {
  const { rules, problems } = sanitizeImport(file({ rules: [{ ...ageRule, conditions: [{ field: 'age', operator: 'olderThan', days: '30' }] }] }));
  assert.deepEqual(problems, []);
  assert.deepEqual(rules[0].conditions, [{ field: 'age', operator: 'olderThan', negate: false, days: 30 }]);
});

test('import drops an age condition with an unusable day count', () => {
  for (const days of [undefined, 0, -3, 1.5, 'lots']) {
    const { rules, problems } = sanitizeImport(
      file({ rules: [{ ...ageRule, conditions: [{ field: 'age', operator: 'olderThan', days }] }] }),
    );
    assert.equal(rules.length, 0, `days=${days}`);
    assert.ok(problems.some((p) => /whole number of days/.test(p)), problems.join('; '));
  }
});

test('import rejects an age operator on a header field and a string operator on age', () => {
  const crossed = [
    { field: 'subject', operator: 'olderThan', days: 3 },
    { field: 'age', operator: 'contains', value: '3' },
    { fields: ['age', 'from'], operator: 'olderThan', days: 3 },
  ];
  for (const c of crossed) {
    const { rules, problems } = sanitizeImport(file({ rules: [{ ...ageRule, conditions: [c] }] }));
    assert.equal(rules.length, 0, JSON.stringify(c));
    assert.ok(problems.some((p) => /does not apply|no recognised/.test(p)), problems.join('; '));
  }
});

test('the day count is part of the fingerprint', () => {
  const thirty = ruleFingerprint(ageRule);
  const sixty = ruleFingerprint({ ...ageRule, conditions: [ageRule.conditions[0], { ...ageRule.conditions[1], days: 60 }] });
  assert.notEqual(thirty, sixty);
  assert.equal(ruleHash(ageRule), ruleHash({ ...ageRule, name: 'renamed' }));
});

// --- Address-book conditions -------------------------------------------------

const bookRule = {
  ...validRule,
  name: 'Strangers to Junk',
  match: 'all',
  conditions: [{ field: 'from', operator: 'inAddressBook', addressBookId: 'all', negate: true }],
};

test('import accepts an address-book condition', () => {
  const { rules, problems } = sanitizeImport(file({ rules: [bookRule] }));
  assert.deepEqual(problems, []);
  assert.deepEqual(rules[0].conditions, [{ field: 'from', operator: 'inAddressBook', negate: true, addressBookId: 'all' }]);
});

test('import keeps an unknown book id but reports it', () => {
  const raw = { ...bookRule, conditions: [{ ...bookRule.conditions[0], addressBookId: 'ldap-elsewhere' }] };
  const { rules, problems } = sanitizeImport(file({ rules: [raw] }), { knownAddressBookIds: ['book-1'] });
  assert.equal(rules[0].conditions[0].addressBookId, 'ldap-elsewhere');
  assert.ok(problems.some((p) => /address book not in this profile/.test(p)), problems.join('; '));
});

test('import accepts an address-book condition on to and cc', () => {
  for (const field of ['to', 'cc']) {
    const raw = { ...bookRule, conditions: [{ ...bookRule.conditions[0], field }] };
    const { rules, problems } = sanitizeImport(file({ rules: [raw] }));
    assert.deepEqual(problems, [], field);
    assert.equal(rules[0].conditions[0].field, field);
  }
});

test('import rejects an address-book condition on a non-address field or with no book', () => {
  for (const c of [
    { field: 'subject', operator: 'inAddressBook', addressBookId: 'all' },
    { field: 'from', operator: 'inAddressBook' },
    { field: 'from', operator: 'inAddressBook', addressBookId: '   ' },
  ]) {
    const { rules } = sanitizeImport(file({ rules: [{ ...bookRule, conditions: [c] }] }));
    assert.equal(rules.length, 0, JSON.stringify(c));
  }
});

test('the address-book id is part of the fingerprint', () => {
  const other = { ...bookRule, conditions: [{ ...bookRule.conditions[0], addressBookId: 'book-2' }] };
  assert.notEqual(ruleFingerprint(bookRule), ruleFingerprint(other));
});

test('includeSubfolders survives a round trip and is false unless set', () => {
  const exported = buildExport({ rules: [{ ...validRule, includeSubfolders: true }, validRule] });
  const { rules } = sanitizeImport(exported);
  assert.deepEqual(rules.map((r) => r.includeSubfolders), [true, false]);
  // Anything but a literal true is off: an import must not widen a rule by accident.
  const loose = sanitizeImport(file({ rules: [{ ...validRule, includeSubfolders: 'yes' }] }));
  assert.equal(loose.rules[0].includeSubfolders, false);
});

test('includeSubfolders changes the fingerprint, and an unset flag leaves it as before', () => {
  assert.notEqual(ruleFingerprint(validRule), ruleFingerprint({ ...validRule, includeSubfolders: true }));
  assert.equal(ruleFingerprint(validRule), ruleFingerprint({ ...validRule, includeSubfolders: false }));
  assert.ok(!ruleFingerprint(validRule).includes('includeSubfolders'));
});

test('a schedule survives a round trip, and a rule without one gains none', () => {
  const scheduled = { ...validRule, schedule: { enabled: true, cron: '0 21 * * *' } };
  const exported = buildExport({ rules: [scheduled, validRule] });
  assert.deepEqual(exported.rules[0].schedule, { enabled: true, cron: '0 21 * * *' });
  assert.ok(!('schedule' in exported.rules[1]));

  const { rules, problems } = sanitizeImport(exported);
  assert.deepEqual(rules[0].schedule, { enabled: true, cron: '0 21 * * *' });
  assert.ok(!('schedule' in rules[1]));
  assert.deepEqual(problems, []);
});

test('an imported schedule that does not parse is turned off and reported', () => {
  const bad = { ...validRule, schedule: { enabled: true, cron: '99 99 * * *' } };
  const { rules, problems } = sanitizeImport(file({ rules: [bad] }));
  assert.deepEqual(rules[0].schedule, { enabled: false, cron: '99 99 * * *' });
  assert.match(problems.join('\n'), /not a valid cron expression/);

  // Anything but a literal true is off, and a non-object is ignored.
  const loose = sanitizeImport(file({ rules: [{ ...validRule, schedule: { enabled: 'yes', cron: '0 21 * * *' } }] }));
  assert.equal(loose.rules[0].schedule.enabled, false);
  assert.ok(!('schedule' in sanitizeImport(file({ rules: [{ ...validRule, schedule: '0 21 * * *' }] })).rules[0]));
});

test('a schedule that is on changes the fingerprint; one that is off or absent does not', () => {
  const on = (cron) => ({ ...validRule, schedule: { enabled: true, cron } });
  assert.notEqual(ruleFingerprint(validRule), ruleFingerprint(on('0 21 * * *')));
  assert.notEqual(ruleFingerprint(on('0 21 * * *')), ruleFingerprint(on('0 8 * * *')));
  // Spacing is not a difference.
  assert.equal(ruleFingerprint(on('0 21 * * *')), ruleFingerprint(on(' 0  21 * * * ')));
  const off = { ...validRule, schedule: { enabled: false, cron: '0 21 * * *' } };
  assert.equal(ruleFingerprint(validRule), ruleFingerprint(off));
  assert.ok(!ruleFingerprint(validRule).includes('schedule'));
});

test('a rule that differs from an existing one only by its schedule is imported', () => {
  const scheduled = { ...validRule, schedule: { enabled: true, cron: '0 21 * * *' } };
  const { rules } = sanitizeImport(file({ rules: [scheduled] }), { existingRules: [validRule] });
  assert.equal(rules.length, 1);
  const again = sanitizeImport(file({ rules: [scheduled] }), { existingRules: [scheduled] });
  assert.equal(again.rules.length, 0);
});

// --- Name-shows-a-different-address conditions -------------------------------

const nameRule = {
  ...validRule,
  name: 'Decoy senders',
  conditions: [{ field: 'from', operator: 'nameShowsOtherAddress', negate: false }],
};

test('import accepts a name check and stores no value for it', () => {
  const { rules, problems } = sanitizeImport(file({ rules: [{ ...nameRule, conditions: [{ ...nameRule.conditions[0], value: 'x' }] }] }));
  assert.deepEqual(problems, []);
  assert.deepEqual(rules[0].conditions, [{ field: 'from', operator: 'nameShowsOtherAddress', negate: false }]);
});

test('import rejects a name check on a field that holds no address', () => {
  const raw = { ...nameRule, conditions: [{ field: 'subject', operator: 'nameShowsOtherAddress' }] };
  const { rules, problems } = sanitizeImport(file({ rules: [raw] }));
  assert.equal(rules.length, 0);
  assert.ok(problems.some((p) => /name check only applies/.test(p)), problems.join('; '));
});

test('a name check survives an export and import round trip', () => {
  const exported = buildExport({ rules: [{ ...nameRule, id: 'n1' }] });
  const { rules, problems } = sanitizeImport(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(problems, []);
  assert.equal(rules[0].conditions[0].operator, 'nameShowsOtherAddress');
});

// --- Read, star, junk, and tag conditions ------------------------------------

const withConditions = (conditions) => file({ rules: [{ ...validRule, match: 'all', conditions }] });

test('import accepts state conditions and stores no value for them', () => {
  const { rules, problems } = sanitizeImport(withConditions([
    { field: 'read', operator: 'isOff', value: 'x' },
    { field: 'STAR', operator: 'isOn' },
    { field: 'junk', operator: 'isOff', negate: true },
  ]));
  assert.deepEqual(problems, []);
  assert.deepEqual(rules[0].conditions, [
    { operator: 'isOff', negate: false, field: 'read' },
    { operator: 'isOn', negate: false, field: 'star' },
    { operator: 'isOff', negate: true, field: 'junk' },
  ]);
});

test('import accepts a tag condition and trims its key', () => {
  const { rules, problems } = sanitizeImport(withConditions([{ field: 'tag', operator: 'hasTag', tagKey: ' $label1 ' }]));
  assert.deepEqual(problems, []);
  assert.deepEqual(rules[0].conditions, [{ operator: 'hasTag', negate: false, field: 'tag', tagKey: '$label1' }]);
});

test('import rejects a state or tag condition with the wrong operator or field', () => {
  for (const c of [
    { field: 'read', operator: 'contains', value: 'x' },
    { field: 'from', operator: 'isOn' },
    { field: 'tag', operator: 'isOn' },
    { field: 'read', operator: 'hasTag', tagKey: 'work' },
    { field: 'subject', operator: 'hasTag', tagKey: 'work' },
    { field: 'age', operator: 'isOff' },
    { fields: ['from', 'read'], operator: 'domainInList', domains: ['evil.com'] },
    { fields: ['read', 'star'], operator: 'isOn' },
    { field: 'tag', operator: 'hasTag' },
    { field: 'tag', operator: 'hasTag', tagKey: '  ' },
  ]) {
    const { rules, problems } = sanitizeImport(withConditions([c]));
    assert.equal(rules.length, 0, JSON.stringify(c));
    assert.ok(problems.length > 0, JSON.stringify(c));
  }
});

test('state and tag conditions survive an export and import round trip', () => {
  const conditions = [
    { field: 'read', operator: 'isOff', negate: false },
    { field: 'tag', operator: 'hasTag', tagKey: 'work', negate: true },
  ];
  const exported = buildExport({ rules: [{ ...validRule, id: 's1', conditions }] });
  const { rules, problems } = sanitizeImport(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(problems, []);
  assert.deepEqual(rules[0].conditions.map((c) => [c.field, c.operator, c.tagKey, c.negate]), [
    ['read', 'isOff', undefined, false],
    ['tag', 'hasTag', 'work', true],
  ]);
});

test('the fingerprint tells apart the state, the operator, and the tag', () => {
  const print = (c) => ruleFingerprint({ ...validRule, conditions: [c] });
  const unread = print({ field: 'read', operator: 'isOff' });
  assert.notEqual(unread, print({ field: 'read', operator: 'isOn' }));
  assert.notEqual(unread, print({ field: 'star', operator: 'isOff' }));
  assert.equal(unread, print({ field: 'read', operator: 'isOff', value: 'ignored' }));
  assert.notEqual(
    print({ field: 'tag', operator: 'hasTag', tagKey: 'work' }),
    print({ field: 'tag', operator: 'hasTag', tagKey: 'home' }),
  );
});

test('import accepts the mark-as-unread, remove-star, and not-junk actions', () => {
  for (const type of ['markUnread', 'markUnflagged', 'markNotJunk']) {
    const { rules, problems } = sanitizeImport(file({ rules: [{ ...validRule, actions: [{ type }] }] }));
    assert.deepEqual(problems, [], type);
    assert.deepEqual(rules[0].actions, [{ type }]);
  }
});
