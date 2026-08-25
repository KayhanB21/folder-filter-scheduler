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
  assert.equal(rules[0].action.type, 'trash');
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
