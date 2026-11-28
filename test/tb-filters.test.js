/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importThunderbirdFilters,
  isThunderbirdFilterFile,
  parseThunderbirdCondition,
  parseThunderbirdFilters,
  parseThunderbirdFolderUri,
  resolveThunderbirdFolderUri,
} from '../src/tb-filters.js';

const KNOWN_FOLDERS = [
  { id: 'acc1://INBOX', accountName: 'alice@gmail.com', path: '/INBOX' },
  { id: 'acc1://Newsletters', accountName: 'alice@gmail.com', path: '/Newsletters' },
  { id: 'acc1://Work/Receipts', accountName: 'alice@gmail.com', path: '/Work/Receipts' },
  { id: 'local://Backup/2026', accountName: 'Local Folders', path: '/Backup/2026' },
];

test('isThunderbirdFilterFile distinguishes msgFilterRules.dat from JSON exports', () => {
  assert.equal(isThunderbirdFilterFile('version="9"\nlogging="yes"\nname="News"\n'), true);
  assert.equal(isThunderbirdFilterFile('\uFEFFversion="9"\r\nlogging="no"\r\n'), true);
  assert.equal(isThunderbirdFilterFile('name="Only"\ncondition="AND (from,contains,a)"'), true);
  assert.equal(isThunderbirdFilterFile('{"format":"folder-filter-scheduler/rules","rules":[]}'), false);
  assert.equal(isThunderbirdFilterFile('[]'), false);
  assert.equal(isThunderbirdFilterFile('hello world'), false);
});

test('parseThunderbirdFilters handles CRLF, escaped quotes, and paired action/actionValue lines', () => {
  const text = [
    'version="9"',
    'logging="yes"',
    'name="Say \\"Hi\\""',
    'enabled="no"',
    'type="17"',
    'action="Move to folder"',
    'actionValue="imap://alice%40gmail.com@imap.gmail.com/Newsletters"',
    'action="Mark read"',
    'action="AddTag"',
    'actionValue="$label1"',
    'condition="OR (from,contains,news@example.com) OR (\\"List-Unsubscribe\\",contains,http)"',
  ].join('\r\n');

  const parsed = parseThunderbirdFilters(text);
  assert.equal(parsed.version, '9');
  assert.equal(parsed.logging, 'yes');
  assert.equal(parsed.filters.length, 1);
  assert.equal(parsed.filters[0].name, 'Say "Hi"');
  assert.equal(parsed.filters[0].enabled, false);
  assert.deepEqual(parsed.filters[0].actions, [
    { type: 'Move to folder', value: 'imap://alice%40gmail.com@imap.gmail.com/Newsletters' },
    { type: 'Mark read', value: '' },
    { type: 'AddTag', value: '$label1' },
  ]);
});

test('parseThunderbirdCondition handles commas, parentheses, quoted headers, and ALL', () => {
  assert.deepEqual(parseThunderbirdCondition('ALL'), { mode: 'ALL', clauses: [] });

  const complex = parseThunderbirdCondition(
    'AND (subject,contains,Re: (urgent), please read) AND ("X-Spam-Status",begins with,Yes)',
  );
  assert.equal(complex.mode, 'all');
  assert.equal(complex.mixed, false);
  assert.deepEqual(complex.clauses, [
    { field: 'subject', customQuoted: false, operator: 'contains', value: 'Re: (urgent), please read' },
    { field: 'X-Spam-Status', customQuoted: true, operator: 'begins with', value: 'Yes' },
  ]);

  const mixed = parseThunderbirdCondition('AND (from,contains,a) OR (subject,contains,b)');
  assert.equal(mixed.mixed, true);
});

test('resolveThunderbirdFolderUri decodes percent-encoding and matches account + path', () => {
  assert.deepEqual(
    parseThunderbirdFolderUri('mailbox://nobody@Local%20Folders/Backup/2026'),
    { accountHints: ['local folders'], path: '/Backup/2026' },
  );
  assert.equal(
    resolveThunderbirdFolderUri('imap://alice%40gmail.com@imap.gmail.com/Work/Receipts', KNOWN_FOLDERS)?.id,
    'acc1://Work/Receipts',
  );
  assert.equal(
    resolveThunderbirdFolderUri('mailbox://nobody@Local%20Folders/Backup/2026', KNOWN_FOLDERS)?.id,
    'local://Backup/2026',
  );
  assert.equal(resolveThunderbirdFolderUri('imap://alice%40gmail.com@imap.gmail.com/Missing', KNOWN_FOLDERS), null);
});

test('importThunderbirdFilters converts rich conditions and actions accurately', () => {
  const dat = `
version="9"
logging="yes"
name="Newsletters & Big Mail"
enabled="yes"
type="17"
action="Move to folder"
actionValue="imap://alice%40gmail.com@imap.gmail.com/Newsletters"
action="AddTag"
actionValue="newsletter"
action="Mark read"
condition="AND (to or cc,contains,alias@example.com) AND (\\"List-Unsubscribe\\",isn't empty,) AND (age in days,is greater than,30) AND (size,is greater than,5120) AND (tag,doesn't contain,keep) AND (priority,is,High) AND (status,isn't,read) AND (junk status,is,good)"
name="Archive Receipts"
enabled="no"
type="17"
action="Copy to folder"
actionValue="mailbox://nobody@Local%20Folders/Backup/2026"
action="Archive"
action="Mark flagged"
action="JunkScore"
actionValue="0"
condition="OR (from,ends with,@shop.example) OR (size,is less than,500) OR (body,matches,invoice #\\d+)"
`;

  const res = importThunderbirdFilters(dat, { knownFolders: KNOWN_FOLDERS });
  assert.deepEqual(res.problems, []);
  assert.equal(res.rules.length, 2);

  const [first, second] = res.rules;
  assert.equal(first.name, 'Newsletters & Big Mail');
  assert.equal(first.enabled, true);
  assert.equal(first.match, 'all');
  assert.deepEqual(first.folderIds, []);
  assert.deepEqual(first.conditions, [
    { field: 'to-cc', operator: 'contains', negate: false, value: 'alias@example.com' },
    { field: 'list-unsubscribe', operator: 'matchesRegex', negate: true, value: '^$' },
    { field: 'age', operator: 'olderThan', days: 30, negate: false },
    { field: 'size', operator: 'largerThan', size: 5, unit: 'MB', negate: false },
    { field: 'tag', operator: 'hasTag', tagKey: 'keep', negate: true },
    { field: 'priority', operator: 'priorityIs', value: 'high', negate: false },
    { field: 'read', operator: 'isOff', negate: false },
    { field: 'junk', operator: 'isOff', negate: false },
  ]);
  assert.deepEqual(first.actions, [
    { type: 'tag', tagKey: 'newsletter' },
    { type: 'markRead' },
    { type: 'move', folderId: 'acc1://Newsletters' },
  ]);

  assert.equal(second.enabled, false);
  assert.equal(second.match, 'any');
  assert.deepEqual(second.conditions, [
    { field: 'from', operator: 'endsWith', negate: false, value: '@shop.example' },
    { field: 'size', operator: 'smallerThan', size: 500, unit: 'KB', negate: false },
    { field: 'body', operator: 'matchesRegex', negate: false, value: 'invoice #\\d+' },
  ]);
  assert.deepEqual(second.actions, [
    { type: 'copy', folderId: 'local://Backup/2026' },
    { type: 'markFlagged' },
    { type: 'markNotJunk' },
    { type: 'archive' },
  ]);
});

test('importThunderbirdFilters reports unsupported items, ALL, address-book mapping, and missing folders', () => {
  const dat = `
version="9"
name="Match Everything"
action="Delete"
condition="ALL"
name="Mixed & Partial"
action="Forward"
actionValue="boss@example.com"
action="Move to folder"
actionValue="imap://alice%40gmail.com@imap.gmail.com/Nonexistent"
action="Delete"
condition="AND (from,is in ab,moz-abmdbdirectory://abook.sqlite) OR (date,is before,01-Jan-2026)"
`;
  const res = importThunderbirdFilters(dat, { knownFolders: KNOWN_FOLDERS });
  assert.equal(res.rules.length, 1);
  assert.equal(res.rules[0].name, 'Mixed & Partial');
  assert.deepEqual(res.rules[0].conditions, [
    { field: 'from', operator: 'inAddressBook', addressBookId: 'all', negate: false },
  ]);
  assert.deepEqual(res.rules[0].actions, [{ type: 'trash' }]);

  const joined = res.problems.join('\n');
  assert.match(joined, /Match all messages/);
  assert.match(joined, /unsupported Thunderbird action "Forward"/);
  assert.match(joined, /destination folder "\/Nonexistent" for "Move to folder" was not found/);
  assert.match(joined, /mixed AND\/OR/);
  assert.match(joined, /address book mapped to All address books/);
  assert.match(joined, /unsupported Thunderbird condition "date is before"/);
});

test('importThunderbirdFilters skips duplicates against existing rules', () => {
  const dat = `
version="9"
name="Kill spam"
action="Delete"
condition="AND (subject,contains,casino)"
`;
  const first = importThunderbirdFilters(dat, { knownFolders: KNOWN_FOLDERS });
  assert.equal(first.rules.length, 1);

  const second = importThunderbirdFilters(dat, {
    knownFolders: KNOWN_FOLDERS,
    existingRules: first.rules,
  });
  assert.equal(second.rules.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(second.duplicates[0].matches, 'Kill spam');
});
