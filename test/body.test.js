/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBodyReads } from '../src/body.js';
import {
  decideWithoutBody,
  evaluateCondition,
  evaluateRule,
  requiresBody,
  requiresFullMessage,
} from '../src/matcher.js';

// --- Matching ----------------------------------------------------------------

const withBody = (body, fields = {}) => ({ fields, body: typeof body === 'string' ? [body] : body });
const PHRASE = { field: 'body', operator: 'contains', value: 'Dear friend, i would' };

test('a body condition matches a phrase in any case', () => {
  assert.equal(evaluateCondition(withBody('Hello.\nDEAR FRIEND, I would like'), PHRASE), true);
  assert.equal(evaluateCondition(withBody('Dear colleague, I would like'), PHRASE), false);
});

test('a phrase matches across a line break and repeated spaces', () => {
  assert.equal(evaluateCondition(withBody('Dear friend,\r\n  i would like'), PHRASE), true);
});

test('a body regex keeps the case of its pattern and sees collapsed lines', () => {
  const regex = { field: 'body', operator: 'matchesRegex', value: String.raw`friend, \D would` };
  assert.equal(evaluateCondition(withBody('Dear friend,\ni would'), regex), true);
  assert.equal(evaluateCondition(withBody('Dear friend,\n1 would'), regex), false);
});

test('a body condition never matches, negated or not, when the body was not read', () => {
  assert.equal(evaluateCondition(withBody(undefined), PHRASE), false);
  assert.equal(evaluateCondition(withBody(null), { ...PHRASE, negate: true }), false);
});

test('a negated body condition matches a body without the phrase', () => {
  assert.equal(evaluateCondition(withBody('Hi there'), { ...PHRASE, negate: true }), true);
  assert.equal(evaluateCondition(withBody(''), { ...PHRASE, negate: true }), true);
});

test('a body condition rejects the operators that are not string operators', () => {
  assert.throws(() => evaluateCondition(withBody('x'), { field: 'body', operator: 'domainInList', domains: ['a.com'] }));
});

test('a body rule needs a body read, not a header read', () => {
  const rule = { match: 'all', conditions: [{ field: 'from', operator: 'contains', value: 'x' }, PHRASE] };
  assert.equal(requiresBody(rule), true);
  assert.equal(requiresFullMessage(rule), false);
  assert.equal(requiresBody({ conditions: [{ field: 'subject', operator: 'contains', value: 'x' }] }), false);
});

// --- Deciding without the body -------------------------------------------------

const FROM_X = { field: 'from', operator: 'contains', value: 'x@example.com' };
const fromX = { fields: { from: ['x@example.com'] } };
const fromY = { fields: { from: ['y@example.com'] } };

test('an "all" rule with a false condition is decided without the body', () => {
  const rule = { match: 'all', conditions: [FROM_X, PHRASE] };
  assert.equal(decideWithoutBody(fromY, rule), false);
  assert.equal(decideWithoutBody(fromX, rule), null);
});

test('an "any" rule with a true condition is decided without the body', () => {
  const rule = { match: 'any', conditions: [FROM_X, PHRASE] };
  assert.equal(decideWithoutBody(fromX, rule), true);
  assert.equal(decideWithoutBody(fromY, rule), null);
});

test('a rule with only a body condition always needs the body', () => {
  assert.equal(decideWithoutBody(fromX, { match: 'all', conditions: [PHRASE] }), null);
  assert.equal(decideWithoutBody(fromX, { match: 'any', conditions: [PHRASE] }), null);
});

test('a rule without a body condition is decided as evaluateRule decides it', () => {
  for (const match of ['all', 'any']) {
    for (const message of [fromX, fromY]) {
      const rule = { match, conditions: [FROM_X] };
      assert.equal(decideWithoutBody(message, rule), evaluateRule(message, rule));
    }
  }
  assert.equal(decideWithoutBody(fromX, { match: 'any', conditions: [] }), false);
});

test('a decision with the body agrees with the full rule', () => {
  const rule = { match: 'all', conditions: [FROM_X, PHRASE] };
  assert.equal(evaluateRule({ ...fromX, body: ['Dear friend, I would'] }, rule), true);
  assert.equal(evaluateRule({ ...fromX, body: ['Hello'] }, rule), false);
});

// The spam in #38 had other text in its plain-text part than in its HTML part.
test('a body condition matches when any part matches', () => {
  const parts = ['Click here', 'Prezado(a) ana@example.com, informamos'];
  const prezado = { field: 'body', operator: 'contains', value: 'Prezado(a) ana@example.com' };
  assert.equal(evaluateCondition(withBody(parts), prezado), true);
  assert.equal(evaluateCondition(withBody(parts), { ...prezado, negate: true }), false);
  const starts = { field: 'body', operator: 'startsWith', value: 'prezado' };
  assert.equal(evaluateCondition(withBody(parts), starts), true);
});

test('a message with no text parts counts as one empty part', () => {
  assert.equal(evaluateCondition(withBody([]), PHRASE), false);
  assert.equal(evaluateCondition(withBody([]), { ...PHRASE, negate: true }), true);
});

// --- Reading -------------------------------------------------------------------

const never = () => new Promise(() => {});

function setup({ parts, limit = 2, toPlainText = async (html) => `TEXT(${html})` }) {
  const logged = [];
  const reads = createBodyReads({
    listInlineTextParts: typeof parts === 'function' ? parts : async () => parts,
    toPlainText,
    timeoutMs: 20,
    limit,
    onTimeout: (message) => logged.push(message),
  });
  return { reads, logged };
}

test('every plain-text and HTML part is read, in message order', async () => {
  const { reads } = setup({
    parts: [
      { contentType: 'text/plain', content: 'one' },
      { contentType: 'text/html', content: '<p>html</p>' },
      { contentType: 'TEXT/PLAIN; charset=utf-8', content: 'two' },
      { contentType: 'text/calendar', content: 'BEGIN:VCALENDAR' },
    ],
  });
  assert.deepEqual(await reads.read(1), ['one', 'TEXT(<p>html</p>)', 'two']);
});

test('an HTML-only message is turned into text', async () => {
  const { reads } = setup({ parts: [{ contentType: 'text/html', content: '<b>hi</b>' }] });
  assert.deepEqual(await reads.read(1), ['TEXT(<b>hi</b>)']);
});

test('a message with no text parts has no body parts', async () => {
  const { reads } = setup({ parts: [] });
  assert.deepEqual(await reads.read(1), []);
});

test('a read with no answer leaves the message out, and reading stops at the limit', async () => {
  const { reads, logged } = setup({ parts: never, limit: 2 });
  assert.equal(await reads.read(1), null);
  assert.equal(reads.stopped, false);
  assert.equal(await reads.read(2), null);
  assert.equal(reads.stopped, true);
  assert.equal(await reads.read(3), null);
  assert.equal(reads.skipped, 3);
  assert.equal(reads.timeouts, 2);
  assert.equal(logged.length, 2);
  assert.match(logged[1], /no more body reads this run/);
});

test('an error other than a timeout is thrown to the caller', async () => {
  const { reads } = setup({ parts: async () => { throw new Error('gone'); } });
  await assert.rejects(reads.read(1), /gone/);
  assert.equal(reads.skipped, 0);
});

test('body reads are cached per run and honour markFailed and budgetMs', async () => {
  let t = 0;
  const calls = [];
  const logged = [];
  const reads = createBodyReads({
    listInlineTextParts: async (id) => {
      calls.push(id);
      t += 15_000;
      return [{ contentType: 'text/plain', content: `body-${id}` }];
    },
    toPlainText: async (html) => html,
    timeoutMs: 20,
    limit: 5,
    budgetMs: 20_000,
    now: () => t,
    onTimeout: (m) => logged.push(m),
  });

  assert.deepEqual(await reads.read(1), ['body-1']);
  assert.deepEqual(await reads.read(1), ['body-1']);
  assert.equal(reads.cached, 1);
  assert.deepEqual(calls, [1]);

  reads.markFailed(9);
  assert.equal(await reads.read(9), null);
  assert.equal(reads.skipped, 1);
  assert.deepEqual(calls, [1]);

  // Second fresh read pushes elapsed to 30s >= 20s; third fresh read hits budget.
  assert.deepEqual(await reads.read(2), ['body-2']);
  assert.equal(await reads.read(3), null);
  assert.equal(reads.stopped, true);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /20 s time budget/);
  // Cached bodies still return even after budget is exhausted.
  assert.deepEqual(await reads.read(1), ['body-1']);
  assert.deepEqual(calls, [1, 2]);
});

test('body budgetMs counts only read time and caps calls to remaining budget', async () => {
  let t = 0;
  const reads = createBodyReads({
    listInlineTextParts: async (id) => {
      t += 150;
      return [{ contentType: 'text/plain', content: `b-${id}` }];
    },
    toPlainText: async (html) => html,
    timeoutMs: 1000,
    limit: 5,
    budgetMs: 20_000,
    now: () => t,
  });

  t += 30_000;
  assert.deepEqual(await reads.read(1), ['b-1']);
  assert.equal(reads.spentMs, 150);
  assert.equal(reads.budgetReached, false);

  const logged = [];
  const capped = createBodyReads({
    listInlineTextParts: never,
    toPlainText: async (html) => html,
    timeoutMs: 80,
    limit: 2,
    budgetMs: 25,
    onTimeout: (m) => logged.push(m),
  });
  assert.equal(await capped.read(1), null);
  assert.equal(capped.budgetReached, true);
  assert.equal(capped.stopped, true);
  assert.equal(capped.timeouts, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /time budget/);
});
