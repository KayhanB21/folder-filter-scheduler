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
