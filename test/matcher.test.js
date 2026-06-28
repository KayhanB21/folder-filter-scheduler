/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, evaluateRule, OPERATORS } from '../src/matcher.js';

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

test('OPERATORS set is the documented contract', () => {
  assert.deepEqual(Object.keys(OPERATORS).sort(), ['contains', 'endsWith', 'is', 'matchesRegex', 'startsWith']);
});
