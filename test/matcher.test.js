/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMAIN_IN_LIST,
  evaluateCondition,
  evaluateRule,
  requiresFullMessage,
  OPERATORS,
} from '../src/matcher.js';

const msg = (fields) => ({ fields });

const spam = msg({
  from: ['"Bella" <bella@example.org>'],
  subject: ['If you like this, wait till you see the others'],
  'reply-to': ['spammer@example.com'],
});

test('contains matches case-insensitively on reply-to', () => {
  assert.equal(
    evaluateCondition(spam, { field: 'reply-to', operator: 'contains', value: 'Spammer' }),
    true,
  );
});

test('contains is false when substring absent', () => {
  assert.equal(
    evaluateCondition(spam, { field: 'reply-to', operator: 'contains', value: 'legit-sender' }),
    false,
  );
});

test('negate inverts the result', () => {
  assert.equal(
    evaluateCondition(spam, { field: 'reply-to', operator: 'contains', value: 'spammer', negate: true }),
    false,
  );
});

test('negated condition is TRUE when the header is entirely missing', () => {
  // "Reply-To does not contain X" should hold for a message with no Reply-To.
  assert.equal(
    evaluateCondition(msg({ from: ['a@b.com'] }), {
      field: 'reply-to',
      operator: 'contains',
      value: 'spammer',
      negate: true,
    }),
    true,
  );
});

test('endsWith matches a From domain', () => {
  assert.equal(
    evaluateCondition(spam, { field: 'from', operator: 'endsWith', value: 'example.org>' }),
    true,
  );
});

test('is performs an exact (trimmed) comparison', () => {
  const m = msg({ from: ['account_update@amazon.com'] });
  assert.equal(evaluateCondition(m, { field: 'from', operator: 'is', value: 'account_update@amazon.com' }), true);
  assert.equal(evaluateCondition(m, { field: 'from', operator: 'is', value: 'amazon.com' }), false);
});

test('matchesRegex with an invalid pattern never throws, just fails to match', () => {
  assert.equal(
    evaluateCondition(spam, { field: 'subject', operator: 'matchesRegex', value: '([unclosed' }),
    false,
  );
});

test('multi-value header: negated contains is false if ANY value matches', () => {
  const m = msg({ 'reply-to': ['clean@ok.com', 'spammer@example.com'] });
  assert.equal(
    evaluateCondition(m, { field: 'reply-to', operator: 'contains', value: 'spammer', negate: true }),
    false,
  );
});

test('unknown operator throws', () => {
  assert.throws(() => evaluateCondition(spam, { field: 'from', operator: 'nope', value: 'x' }));
});

test('rule match=any is an OR across conditions', () => {
  const rule = {
    match: 'any',
    conditions: [
      { field: 'from', operator: 'endsWith', value: '@nope.com' },
      { field: 'reply-to', operator: 'contains', value: 'spammer' },
    ],
  };
  assert.equal(evaluateRule(spam, rule), true);
});

test('rule match=all is an AND across conditions', () => {
  const rule = {
    match: 'all',
    conditions: [
      { field: 'from', operator: 'endsWith', value: '@nope.com' },
      { field: 'reply-to', operator: 'contains', value: 'spammer' },
    ],
  };
  assert.equal(evaluateRule(spam, rule), false);
});

test('a rule with no conditions never matches', () => {
  assert.equal(evaluateRule(spam, { match: 'any', conditions: [] }), false);
});

test('requiresFullMessage is false for cheap-field-only rules', () => {
  const rule = {
    match: 'any',
    conditions: [
      { field: 'from', operator: 'endsWith', value: '@x.com' },
      { field: 'subject', operator: 'contains', value: 'sale' },
    ],
  };
  assert.equal(requiresFullMessage(rule), false);
});

test('requiresFullMessage is true when a rule needs reply-to', () => {
  const rule = {
    match: 'any',
    conditions: [
      { field: 'from', operator: 'endsWith', value: '@x.com' },
      { field: 'reply-to', operator: 'contains', value: 'spammer' },
    ],
  };
  assert.equal(requiresFullMessage(rule), true);
});

test('requiresFullMessage handles missing/empty conditions', () => {
  assert.equal(requiresFullMessage({}), false);
  assert.equal(requiresFullMessage({ conditions: [] }), false);
});

test('OPERATORS set is the documented contract', () => {
  assert.deepEqual(Object.keys(OPERATORS).sort(), ['contains', 'endsWith', 'is', 'matchesRegex', 'startsWith']);
});

// --- domainInList ---------------------------------------------------------

const blocklisted = msg({ 'reply-to': ['"Spam" <noreply@evil.com>'] });

test('domainInList matches the exact domain', () => {
  assert.equal(
    evaluateCondition(blocklisted, {
      field: 'reply-to',
      operator: DOMAIN_IN_LIST,
      domains: ['evil.com'],
    }),
    true,
  );
});

test('domainInList matches a subdomain of a listed domain', () => {
  const m = msg({ 'reply-to': ['bounce@mail.evil.com'] });
  assert.equal(
    evaluateCondition(m, { field: 'reply-to', operator: DOMAIN_IN_LIST, domains: ['evil.com'] }),
    true,
  );
});

test('domainInList does not match a lookalike domain', () => {
  assert.equal(
    evaluateCondition(blocklisted, {
      field: 'reply-to',
      operator: DOMAIN_IN_LIST,
      domains: ['notevil.com', 'evil.com.co'],
    }),
    false,
  );
});

test('domainInList with an EMPTY list never matches', () => {
  // The safety invariant: a blank blocklist on a match:"any" delete rule must
  // not evaluate true for every message and empty the folder.
  for (const domains of [[], ['', '  '], undefined]) {
    assert.equal(
      evaluateCondition(blocklisted, { field: 'reply-to', operator: DOMAIN_IN_LIST, domains }),
      false,
      `empty list matched: ${JSON.stringify(domains)}`,
    );
  }
});

test('domainInList on an empty list is false even when negated', () => {
  // Negation must not resurrect the empty-list wildcard from the other side.
  assert.equal(
    evaluateCondition(blocklisted, {
      field: 'reply-to',
      operator: DOMAIN_IN_LIST,
      domains: [],
      negate: true,
    }),
    false,
  );
});

test('domainInList negation inverts a real list', () => {
  assert.equal(
    evaluateCondition(blocklisted, {
      field: 'reply-to',
      operator: DOMAIN_IN_LIST,
      domains: ['evil.com'],
      negate: true,
    }),
    false,
  );
  assert.equal(
    evaluateCondition(blocklisted, {
      field: 'reply-to',
      operator: DOMAIN_IN_LIST,
      domains: ['other.com'],
      negate: true,
    }),
    true,
  );
});

test('domainInList is false when the header is missing entirely', () => {
  assert.equal(
    evaluateCondition(msg({ from: ['a@evil.com'] }), {
      field: 'reply-to',
      operator: DOMAIN_IN_LIST,
      domains: ['evil.com'],
    }),
    false,
  );
});

test('domainInList checks every address in a multi-address header', () => {
  const m = msg({ 'reply-to': ['"Doe, John" <john@ok.com>, spam@evil.com'] });
  assert.equal(
    evaluateCondition(m, { field: 'reply-to', operator: DOMAIN_IN_LIST, domains: ['evil.com'] }),
    true,
  );
});

test('domainInList works against the cheap from field too', () => {
  const rule = {
    match: 'any',
    conditions: [{ field: 'from', operator: DOMAIN_IN_LIST, domains: ['evil.com'] }],
  };
  assert.equal(evaluateRule(msg({ from: ['"X" <x@evil.com>'] }), rule), true);
  // from is a cheap field, so such a rule still needs no full-message fetch.
  assert.equal(requiresFullMessage(rule), false);
});

test('a domainInList rule on reply-to requires the full message', () => {
  assert.equal(
    requiresFullMessage({
      conditions: [{ field: 'reply-to', operator: DOMAIN_IN_LIST, domains: ['evil.com'] }],
    }),
    true,
  );
});

test('DOMAIN_IN_LIST is deliberately not one of the string OPERATORS', () => {
  assert.equal(OPERATORS[DOMAIN_IN_LIST], undefined);
});

// --- Age conditions ---------------------------------------------------------

import { AGE_FIELD, AGE_OPERATORS, CHEAP_FIELDS, ageDays } from '../src/matcher.js';

const now = new Date('2026-09-09T12:00:00Z');
const daysOld = (n) => ({ fields: {}, date: new Date(now.getTime() - n * 24 * 60 * 60 * 1000) });
const older = (days, extra = {}) => ({ field: AGE_FIELD, operator: AGE_OPERATORS.olderThan, days, ...extra });
const newer = (days, extra = {}) => ({ field: AGE_FIELD, operator: AGE_OPERATORS.newerThan, days, ...extra });

test('olderThan matches at and beyond the threshold, not before it', () => {
  assert.equal(evaluateCondition(daysOld(31), older(30), { now }), true);
  assert.equal(evaluateCondition(daysOld(30), older(30), { now }), true);
  assert.equal(evaluateCondition(daysOld(29.9), older(30), { now }), false);
});

test('newerThan is the exact complement of olderThan', () => {
  for (const age of [0, 29.9, 30, 31]) {
    assert.notEqual(
      evaluateCondition(daysOld(age), older(30), { now }),
      evaluateCondition(daysOld(age), newer(30), { now }),
    );
  }
});

test('negate flips an age condition', () => {
  assert.equal(evaluateCondition(daysOld(40), older(30, { negate: true }), { now }), false);
  assert.equal(evaluateCondition(daysOld(10), older(30, { negate: true }), { now }), true);
});

test('an age condition without a usable day count never matches, even negated', () => {
  for (const days of [undefined, null, '', 0, -1, 1.5, 'abc']) {
    assert.equal(evaluateCondition(daysOld(400), older(days), { now }), false, `days=${days}`);
    assert.equal(evaluateCondition(daysOld(400), older(days, { negate: true }), { now }), false);
  }
});

test('a message with no usable date never matches an age condition', () => {
  assert.equal(evaluateCondition({ fields: {} }, older(1), { now }), false);
  assert.equal(evaluateCondition({ fields: {}, date: 'garbage' }, older(1), { now }), false);
});

test('age accepts a timestamp string as well as a Date', () => {
  const msgIso = { fields: {}, date: daysOld(45).date.toISOString() };
  assert.equal(evaluateCondition(msgIso, older(30), { now }), true);
});

test('ageDays accepts numeric strings and rejects everything unusable', () => {
  assert.equal(ageDays({ days: '30' }), 30);
  assert.equal(ageDays({ days: 7 }), 7);
  assert.equal(ageDays({ days: '0' }), null);
  assert.equal(ageDays({ days: '2.5' }), null);
  assert.equal(ageDays({}), null);
});

test('evaluateRule threads `now` through to age conditions', () => {
  const rule = { match: 'all', conditions: [older(30), { field: 'subject', operator: 'contains', value: 'alert' }] };
  const m = { ...daysOld(45), fields: { subject: ['Security alert'] } };
  assert.equal(evaluateRule(m, rule, { now }), true);
  assert.equal(evaluateRule(m, rule, { now: daysOld(20).date }), false);
});

test('an age-only rule is cheap: no full message fetch', () => {
  assert.ok(CHEAP_FIELDS.includes(AGE_FIELD));
  assert.equal(requiresFullMessage({ conditions: [older(30)] }), false);
  assert.equal(requiresFullMessage({ conditions: [older(30), { field: 'reply-to', operator: 'is', value: 'x' }] }), true);
});

// --- Address-book conditions -------------------------------------------------

import { IN_ADDRESS_BOOK, addressBookIdsOf } from '../src/matcher.js';

const books = new Map([
  ['all', new Set(['alice@example.com', 'bob@example.org'])],
  ['empty', new Set()],
  ['broken', null],
]);
const inBook = (id, extra = {}) => ({ field: 'from', operator: IN_ADDRESS_BOOK, addressBookId: id, ...extra });
const fromMsg = (...from) => ({ fields: { from } });

test('inAddressBook matches a known sender regardless of display name or case', () => {
  assert.equal(evaluateCondition(fromMsg('"Alice" <ALICE@example.com>'), inBook('all'), { addressBooks: books }), true);
  assert.equal(evaluateCondition(fromMsg('stranger@spam.example'), inBook('all'), { addressBooks: books }), false);
});

test('negated inAddressBook matches strangers only', () => {
  const notIn = inBook('all', { negate: true });
  assert.equal(evaluateCondition(fromMsg('stranger@spam.example'), notIn, { addressBooks: books }), true);
  assert.equal(evaluateCondition(fromMsg('bob@example.org'), notIn, { addressBooks: books }), false);
});

test('an unreadable, empty, missing, or unloaded book never matches, negated or not', () => {
  const m = fromMsg('stranger@spam.example');
  for (const negate of [false, true]) {
    for (const id of ['empty', 'broken', 'nope']) {
      assert.equal(evaluateCondition(m, inBook(id, { negate }), { addressBooks: books }), false, `${id} negate=${negate}`);
    }
    assert.equal(evaluateCondition(m, inBook('all', { negate })), false, `no books passed, negate=${negate}`);
  }
});

test('a message with no usable sender address never matches, negated or not', () => {
  for (const negate of [false, true]) {
    assert.equal(evaluateCondition({ fields: {} }, inBook('all', { negate }), { addressBooks: books }), false);
    assert.equal(evaluateCondition(fromMsg('undisclosed'), inBook('all', { negate }), { addressBooks: books }), false);
  }
});

test('any known address in a multi-address header counts as known', () => {
  const m = { fields: { 'reply-to': ['x@spam.example, "Bob" <bob@example.org>'] } };
  const cond = { field: 'reply-to', operator: IN_ADDRESS_BOOK, addressBookId: 'all' };
  assert.equal(evaluateCondition(m, cond, { addressBooks: books }), true);
  assert.equal(evaluateCondition(m, { ...cond, negate: true }, { addressBooks: books }), false);
});

test('an address-book condition on to or cc matches when any recipient is known', () => {
  const m = { fields: { to: ['me@home.example', '"Bob" <bob@example.org>'], cc: ['x@spam.example'] } };
  for (const field of ['to', 'cc']) {
    const cond = { field, operator: IN_ADDRESS_BOOK, addressBookId: 'all' };
    const known = field === 'to';
    assert.equal(evaluateCondition(m, cond, { addressBooks: books }), known, field);
    assert.equal(evaluateCondition(m, { ...cond, negate: true }, { addressBooks: books }), !known, `not ${field}`);
  }
});

test('an address-book rule on to or cc stays on the cheap path', () => {
  assert.equal(requiresFullMessage({ conditions: [{ ...inBook('all'), field: 'to' }] }), false);
  assert.equal(requiresFullMessage({ conditions: [{ ...inBook('all'), field: 'cc' }] }), false);
});

test('addressBookIdsOf lists each needed book once', () => {
  const rule = { conditions: [inBook('a'), inBook('a'), inBook('b'), { field: 'from', operator: 'contains', value: 'x' }] };
  assert.deepEqual(addressBookIdsOf(rule).sort(), ['a', 'b']);
});

test('an address-book rule on from stays on the cheap path', () => {
  assert.equal(requiresFullMessage({ conditions: [inBook('all')] }), false);
  assert.equal(requiresFullMessage({ conditions: [{ ...inBook('all'), field: 'reply-to' }] }), true);
});
