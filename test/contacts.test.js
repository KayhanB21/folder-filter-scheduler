/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressSetFromVCards, emailsFromVCard, normalizeAddress } from '../src/contacts.js';

test('normalizeAddress handles bare, display-name, mailto and case', () => {
  assert.equal(normalizeAddress('Alice@Example.COM'), 'alice@example.com');
  assert.equal(normalizeAddress('"Smith, Alice" <Alice@Example.com>'), 'alice@example.com');
  assert.equal(normalizeAddress('mailto:bob@example.org'), 'bob@example.org');
  assert.equal(normalizeAddress('  carol@example.net  '), 'carol@example.net');
});

test('normalizeAddress rejects things that are not addresses', () => {
  for (const bad of ['', null, undefined, 'no-at-sign', '@example.com', 'user@', 'two words@x.com', '<>']) {
    assert.equal(normalizeAddress(bad), null, String(bad));
  }
});

const vcard = [
  'BEGIN:VCARD',
  'VERSION:4.0',
  'FN:Alice Smith',
  'EMAIL;PREF=1:alice@example.com',
  'email;TYPE=work:Alice.Smith@Work.Example',
  'item1.EMAIL:alias@example.org',
  'EMAIL;X-LABEL="home: main":home@example.net',
  'NOTE:EMAIL:not-an-email-property@example.com',
  'TEL:+1 555 0100',
  'END:VCARD',
].join('\r\n');

test('emailsFromVCard reads every EMAIL property and nothing else', () => {
  assert.deepEqual(emailsFromVCard(vcard), [
    'alice@example.com',
    'alice.smith@work.example',
    'alias@example.org',
    'home@example.net',
  ]);
});

test('emailsFromVCard unfolds continuation lines', () => {
  const folded = 'BEGIN:VCARD\r\nEMAIL:very.long.address@exa\r\n mple.com\r\nEND:VCARD';
  assert.deepEqual(emailsFromVCard(folded), ['very.long.address@example.com']);
});

test('emailsFromVCard tolerates junk input', () => {
  assert.deepEqual(emailsFromVCard(undefined), []);
  assert.deepEqual(emailsFromVCard('EMAIL:'), []);
  assert.deepEqual(emailsFromVCard('EMAIL:not an address'), []);
});

test('addressSetFromVCards dedupes across contacts', () => {
  const set = addressSetFromVCards([vcard, 'EMAIL:ALICE@example.com', null]);
  assert.equal(set.size, 4);
  assert.ok(set.has('alice@example.com'));
});
