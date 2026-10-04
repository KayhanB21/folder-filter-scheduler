/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ALLOWLIST,
  addressesFromHeaderValue,
  domainFromAddress,
  domainsFromHeaderValue,
  harvestDomains,
  nameShowsOtherAddress,
  splitMailbox,
  isAllowlisted,
  isValidDomain,
  matchesDomainList,
  mergeDomainLists,
  normalizeDomain,
  parseDomainList,
} from '../src/domains.js';

test('domainFromAddress tolerates a leading @, matching parseDomainList', () => {
  assert.equal(domainFromAddress('@b.com'), 'b.com');
});

test('domainFromAddress handles bare and display-name forms', () => {
  assert.equal(domainFromAddress('spammer@example.com'), 'example.com');
  assert.equal(domainFromAddress('"Bella" <bella@Example.ORG>'), 'example.org');
  assert.equal(domainFromAddress('  <a@b.co.uk>  '), 'b.co.uk');
});

test('domainFromAddress returns null when there is nothing usable', () => {
  for (const input of ['', '   ', null, undefined, 'not-an-address', 'a@', 'a@localhost']) {
    assert.equal(domainFromAddress(input), null, `expected null for ${JSON.stringify(input)}`);
  }
});

test('isValidDomain rejects exactly the things that would swallow a folder', () => {
  // An empty or dotless needle is the footgun: it must never pass validation.
  for (const bad of ['', '   ', '.', '..', 'com', 'evil', '-evil.com', 'evil-.com', 'a..b.com', '.evil.com', 'ev il.com', 'a@b.com', '192.168.0.1']) {
    assert.equal(isValidDomain(bad), false, `expected invalid: ${JSON.stringify(bad)}`);
  }
  for (const good of ['evil.com', 'evil.com.', 'mail.evil.co.uk', 'xn--80ak6aa92e.com', 'a1-b2.example.org']) {
    assert.equal(isValidDomain(good), true, `expected valid: ${good}`);
  }
});

test('normalizeDomain lowercases, trims, and drops the FQDN root dot', () => {
  assert.equal(normalizeDomain('  Evil.COM.  '), 'evil.com');
});

test('addressesFromHeaderValue does not split on a comma inside a quoted name', () => {
  const header = '"Doe, John" <john@a.com>, jane@b.com';
  assert.deepEqual(addressesFromHeaderValue(header), ['"Doe, John" <john@a.com>', 'jane@b.com']);
});

test('domainsFromHeaderValue returns every distinct domain in one header', () => {
  assert.deepEqual(
    domainsFromHeaderValue('"Doe, John" <john@a.com>, jane@b.com, other@A.com'),
    ['a.com', 'b.com'],
  );
});

test('matchesDomainList matches subdomains but never a bare TLD', () => {
  const list = ['evil.com'];
  assert.equal(matchesDomainList('evil.com', list), true);
  assert.equal(matchesDomainList('bounce.evil.com', list), true);
  assert.equal(matchesDomainList('a.b.c.evil.com', list), true);
  assert.equal(matchesDomainList('notevil.com', list), false);
  assert.equal(matchesDomainList('evil.com.co', list), false);
  // A bogus bare-TLD entry must not turn into a wildcard.
  assert.equal(matchesDomainList('anything.com', ['com']), false);
});

test('matchesDomainList never matches an empty list', () => {
  // The single most important invariant: a blank blocklist affects nothing.
  assert.equal(matchesDomainList('evil.com', []), false);
  assert.equal(matchesDomainList('evil.com', new Set()), false);
  assert.equal(matchesDomainList('evil.com', ['', '   ']), false);
});

test('isAllowlisted covers subdomains of a listed provider', () => {
  assert.equal(isAllowlisted('gmail.com'), true);
  assert.equal(isAllowlisted('mail.gmail.com'), true);
  assert.equal(isAllowlisted('notgmail.com'), false);
  assert.ok(DEFAULT_ALLOWLIST.includes('yahoo.com'));
});

test('harvestDomains separates keepers, allowlisted, and unusable input', () => {
  const result = harvestDomains([
    '"Spam" <a@evil.com>',
    'b@evil.com', // duplicate domain, collapses
    'c@mail.evil.net',
    'legit@gmail.com',
    'garbage',
  ]);
  assert.deepEqual(result.accepted, ['evil.com', 'mail.evil.net']);
  assert.deepEqual(result.skippedAllowlisted, ['gmail.com']);
  assert.deepEqual(result.skippedInvalid, ['garbage']);
});

test('harvestDomains accepts a caller-supplied allowlist', () => {
  const result = harvestDomains(['a@evil.com'], ['evil.com']);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.skippedAllowlisted, ['evil.com']);
});

test('parseDomainList cleans a textarea and reports what it dropped', () => {
  const { domains, invalid } = parseDomainList(`
    Evil.COM
    # a comment
    spammer@bad.org
    @other.net
    nonsense
    evil.com
  `);
  assert.deepEqual(domains, ['bad.org', 'evil.com', 'other.net']);
  assert.deepEqual(invalid, ['nonsense']);
});

test('parseDomainList on empty input yields an empty list, not a wildcard', () => {
  assert.deepEqual(parseDomainList('').domains, []);
  assert.deepEqual(parseDomainList('   \n\n  ').domains, []);
});

test('mergeDomainLists unions, sorts, and reports only genuinely new entries', () => {
  const { domains, added } = mergeDomainLists(['b.com'], ['a.com', 'B.com', 'bad', '']);
  assert.deepEqual(domains, ['a.com', 'b.com']);
  assert.deepEqual(added, ['a.com']);
});

// --- Display names that hold an address -------------------------------------

const DECOY = '"LENA <Lena2005@yahoo.com>" <tianwan1234@sina.com>';

test('splitMailbox takes the real address, not one inside the display name', () => {
  assert.deepEqual(splitMailbox(DECOY), { name: '"LENA <Lena2005@yahoo.com>"', address: 'tianwan1234@sina.com' });
  // The same mailbox as Thunderbird can hand it over, without the quotes.
  assert.equal(splitMailbox('LENA <Lena2005@yahoo.com> <tianwan1234@sina.com>').address, 'tianwan1234@sina.com');
  assert.equal(splitMailbox('"A \\"quoted\\" <x@decoy.com>" <real@ok.com>').address, 'real@ok.com');
  assert.deepEqual(splitMailbox('"Bella" <bella@example.org>'), { name: '"Bella"', address: 'bella@example.org' });
  assert.deepEqual(splitMailbox(' bella@example.org '), { name: '', address: 'bella@example.org' });
  assert.deepEqual(splitMailbox(undefined), { name: '', address: '' });
});

test('splitMailbox falls back to the last pair when quoting is broken', () => {
  assert.equal(splitMailbox('"LENA <a@yahoo.com> <b@sina.com>').address, 'b@sina.com');
  assert.equal(splitMailbox('"only <x@quoted.com>"').address, 'x@quoted.com');
});

test('the domain of a mailbox is the real sender domain, not the decoy', () => {
  assert.equal(domainFromAddress(DECOY), 'sina.com');
  assert.deepEqual(domainsFromHeaderValue(`${DECOY}, "Ann" <ann@ok.com>`), ['sina.com', 'ok.com']);
});

test('a decoy from a protected provider no longer hides the real domain', () => {
  const { accepted, skippedAllowlisted } = harvestDomains([DECOY]);
  assert.deepEqual(accepted, ['sina.com']);
  assert.deepEqual(skippedAllowlisted, []);
});

test('nameShowsOtherAddress is true only for an address from another domain', () => {
  assert.equal(nameShowsOtherAddress(DECOY), true);
  assert.equal(nameShowsOtherAddress('LENA <Lena2005@yahoo.com> <tianwan1234@sina.com>'), true);
  assert.equal(nameShowsOtherAddress('"ann@ok.com via List" <list@lists.example>'), true);
  assert.equal(nameShowsOtherAddress('"ann@ok.com" <ann@ok.com>'), false);
  assert.equal(nameShowsOtherAddress('"Ann <ann.smith@OK.com>" <asmith@ok.com>'), false);
  assert.equal(nameShowsOtherAddress('"Ann <ann@ok.com>" <ann@mail.ok.com>'), false);
  assert.equal(nameShowsOtherAddress('"Ann @ work" <ann@ok.com>'), false);
  assert.equal(nameShowsOtherAddress('"Ann" <ann@ok.com>'), false);
  assert.equal(nameShowsOtherAddress('ann@ok.com'), false);
  assert.equal(nameShowsOtherAddress('"ann@ok.com" <not an address>'), false);
  assert.equal(nameShowsOtherAddress(undefined), false);
});
