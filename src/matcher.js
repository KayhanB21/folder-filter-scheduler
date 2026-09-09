/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure, side-effect-free rule matching.
 *
 * This module deliberately has ZERO dependency on the WebExtension / Thunderbird
 * APIs so it can be unit-tested under plain Node. The background script feeds it
 * a normalized message and a rule; it returns whether the rule matches.
 *
 * A normalized message is `{ fields: { <lowercased-name>: string[] } }`.
 * Header-like fields ("from", "subject", "reply-to", "x-anything") map to the
 * raw header values exactly as Thunderbird's header APIs return them
 * (lowercased keys, array values because a header may legally repeat).
 */

import { domainsFromHeaderValue, matchesDomainList, normalizeDomain } from './domains.js';

/** Operators are positive predicates; negation is a separate flag on a condition. */
export const OPERATORS = Object.freeze({
  contains: (value, needle) => value.includes(needle),
  is: (value, needle) => value.trim() === needle.trim(),
  startsWith: (value, needle) => value.startsWith(needle),
  endsWith: (value, needle) => value.endsWith(needle),
  matchesRegex: (value, needle) => {
    // A bad pattern must never crash a scheduled run — treat it as "no match".
    try {
      return new RegExp(needle, 'i').test(value);
    } catch {
      return false;
    }
  },
});

/**
 * The set-lookup operator, kept out of OPERATORS on purpose: those entries are
 * `(value, needle)` string predicates and cannot express a lookup against a
 * whole list. evaluateCondition branches on it before reaching them.
 */
export const DOMAIN_IN_LIST = 'domainInList';

/**
 * The message-age pseudo-field. Not a header: it compares the message date
 * against "now". Its operators live outside OPERATORS for the same reason as
 * DOMAIN_IN_LIST, they are not string predicates. Shape:
 * `{ field: 'age', operator: 'olderThan' | 'newerThan', days: N, negate }`.
 */
export const AGE_FIELD = 'age';
export const AGE_OPERATORS = Object.freeze({
  olderThan: 'olderThan',
  newerThan: 'newerThan',
});

export const FIELDS = Object.freeze([
  'from',
  'to',
  'cc',
  'subject',
  'reply-to',
  'list-id',
  'sender',
  AGE_FIELD,
]);

/**
 * Fields obtainable for free from a lightweight MessageHeader (author,
 * recipients, ccList, subject) — i.e. without fetching the full message.
 * Everything else (reply-to, list-id, sender, arbitrary headers) needs a
 * `messages.getFull()`, which on a non-offline IMAP folder hits the network.
 */
export const CHEAP_FIELDS = Object.freeze(['from', 'to', 'cc', 'subject', AGE_FIELD]);

const foldCase = (s) => (s ?? '').toString().toLowerCase();

/**
 * The header(s) a condition reads. `fields` (plural) lets one domain-list
 * condition watch both Reply-To and From, which matters because most spam
 * carries only one of the two. Falls back to the singular `field` so rules
 * written before this existed keep working.
 */
export function isAgeCondition(condition) {
  return foldCase(condition?.field) === AGE_FIELD;
}

/**
 * The day count of an age condition, or null when it is unusable. Anything
 * that is not a whole number of at least one day never matches: an age
 * condition with a blank or zero count on an `any` rule would otherwise be
 * true for every message.
 */
export function ageDays(condition) {
  const n = Number(condition?.days);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function fieldsOf(condition) {
  if (Array.isArray(condition?.fields) && condition.fields.length > 0) return condition.fields;
  return condition?.field ? [condition.field] : [];
}

/**
 * True when a rule references at least one header that is NOT cheaply
 * available, so the engine must fetch the full message to evaluate it.
 * Lets a from/subject-only rule run with zero downloads.
 */
export function requiresFullMessage(rule) {
  const cheap = new Set(CHEAP_FIELDS);
  return (rule?.conditions ?? []).some((c) => {
    // A condition naming no field at all is treated as expensive, erring toward
    // fetching rather than silently evaluating against nothing.
    const fields = fieldsOf(c);
    return (fields.length > 0 ? fields : ['']).some((f) => !cheap.has(foldCase(f)));
  });
}

function valuesFor(message, field) {
  const key = foldCase(field);
  const fields = message && message.fields ? message.fields : {};
  return Array.isArray(fields[key]) ? fields[key] : [];
}

/**
 * Evaluate one condition against a message.
 *
 * Multi-value semantics: a positive condition matches if ANY header value
 * satisfies it; a negated condition matches only if NO value satisfies it
 * (i.e. "Reply-To does not contain X" must be false the moment one value does).
 * A field that is entirely absent counts as a single empty string, so
 * "does not contain X" is true for a message that lacks the header.
 */
/**
 * Evaluate a `domainInList` condition: does any address in the chosen header
 * sit in (or under) the condition's domain list?
 *
 * An empty list NEVER matches. Without this a blank blocklist on a `match:
 * "any"` rule would be true for every message, and a rule that deletes would
 * empty the folder on the next scheduled run.
 */
function evaluateDomainCondition(message, condition) {
  const domains = Array.isArray(condition.domains) ? condition.domains : [];
  const list = new Set(domains.map(normalizeDomain).filter(Boolean));
  if (list.size === 0) return false;

  const anySatisfied = fieldsOf(condition).some((field) =>
    valuesFor(message, field).some((value) =>
      domainsFromHeaderValue(value).some((domain) => matchesDomainList(domain, list)),
    ),
  );
  return condition.negate ? !anySatisfied : anySatisfied;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Evaluate an age condition. `message.date` is the Date header as Thunderbird
 * indexed it, which is what the native "Age in Days" filter and the folder
 * retention policy use too. A message with no usable date never matches.
 */
function evaluateAgeCondition(message, condition, now) {
  const days = ageDays(condition);
  const date = message?.date instanceof Date ? message.date : new Date(message?.date ?? NaN);
  if (days === null || Number.isNaN(date.getTime())) return false;

  const ageMs = now.getTime() - date.getTime();
  let satisfied;
  if (condition.operator === AGE_OPERATORS.olderThan) satisfied = ageMs >= days * DAY_MS;
  else if (condition.operator === AGE_OPERATORS.newerThan) satisfied = ageMs < days * DAY_MS;
  else throw new Error(`Unknown age operator: ${condition.operator}`);
  return condition.negate ? !satisfied : satisfied;
}

export function evaluateCondition(message, condition, { now = new Date() } = {}) {
  if (isAgeCondition(condition)) return evaluateAgeCondition(message, condition, now);
  if (condition.operator === DOMAIN_IN_LIST) return evaluateDomainCondition(message, condition);

  const predicate = OPERATORS[condition.operator];
  if (!predicate) {
    throw new Error(`Unknown operator: ${condition.operator}`);
  }
  const needle = foldCase(condition.value);
  let values = valuesFor(message, condition.field).map(foldCase);
  if (values.length === 0) values = [''];

  const anySatisfied = values.some((v) => predicate(v, needle));
  return condition.negate ? !anySatisfied : anySatisfied;
}

/**
 * Evaluate a whole rule. `rule.match` is "all" (AND) or "any" (OR).
 * A rule with no conditions never matches — guards against an empty rule
 * silently swallowing an entire folder.
 */
export function evaluateRule(message, rule, options = {}) {
  const conditions = rule && Array.isArray(rule.conditions) ? rule.conditions : [];
  if (conditions.length === 0) return false;

  const results = conditions.map((c) => evaluateCondition(message, c, options));
  return rule.match === 'all' ? results.every(Boolean) : results.some(Boolean);
}
