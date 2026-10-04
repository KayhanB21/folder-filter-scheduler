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
 * A normalized message is `{ fields: { <lowercased-name>: string[] } }`, plus
 * `date`, `state` (read, star, junk), and `tags` for the conditions that are
 * not about a header.
 * Header-like fields ("from", "subject", "reply-to", "x-anything") map to the
 * raw header values exactly as Thunderbird's header APIs return them
 * (lowercased keys, array values because a header may legally repeat).
 */

import {
  addressesFromHeaderValue,
  domainsFromHeaderValue,
  matchesDomainList,
  nameShowsOtherAddress,
  normalizeDomain,
} from './domains.js';
import { normalizeAddress } from './contacts.js';

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
 * "Sender is in an address book". Like DOMAIN_IN_LIST it is a set lookup, not a
 * string predicate. Shape: `{ field, operator: 'inAddressBook', addressBookId,
 * negate }`, where addressBookId is a book id or ALL_ADDRESS_BOOKS. The address
 * Sets themselves are loaded by the background script and passed in through
 * evaluateRule's options, which keeps this module free of extension APIs.
 */
export const IN_ADDRESS_BOOK = 'inAddressBook';

/**
 * "The sender name shows a different address". True when a display name in
 * the field contains an email address from another domain than the real
 * address beside it, which is how spam shows a sender it is not. It takes no
 * value. Shape: `{ field, operator: 'nameShowsOtherAddress', negate }`.
 */
export const NAME_SHOWS_OTHER_ADDRESS = 'nameShowsOtherAddress';

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

/**
 * Message-state pseudo-fields: whether a message is read, starred, or marked
 * as junk. Not headers. The background script copies them from the indexed
 * message into `message.state`, so they cost no download. Shape:
 * `{ field: 'read' | 'star' | 'junk', operator: 'isOn' | 'isOff', negate }`.
 */
export const STATE_FIELDS = Object.freeze(['read', 'star', 'junk']);
export const STATE_OPERATORS = Object.freeze({ isOn: 'isOn', isOff: 'isOff' });
/** What each state operator means for each field, in the user's words. */
export const STATE_LABELS = Object.freeze({
  read: Object.freeze({ isOn: 'is read', isOff: 'is unread' }),
  star: Object.freeze({ isOn: 'is starred', isOff: 'is not starred' }),
  junk: Object.freeze({ isOn: 'is junk', isOff: 'is not junk' }),
});

/**
 * The tag pseudo-field. `message.tags` holds the keys of the tags on the
 * message, also free. Shape: `{ field: 'tag', operator: 'hasTag', tagKey,
 * negate }`.
 */
export const TAG_FIELD = 'tag';
export const HAS_TAG = 'hasTag';

export const FIELDS = Object.freeze([
  'from',
  'to',
  'cc',
  'subject',
  'reply-to',
  'list-id',
  'sender',
  AGE_FIELD,
  ...STATE_FIELDS,
  TAG_FIELD,
]);

/**
 * Fields obtainable for free from a lightweight MessageHeader (author,
 * recipients, ccList, subject) — i.e. without fetching the full message.
 * Everything else (reply-to, list-id, sender, arbitrary headers) needs a
 * `messages.getFull()`, which on a non-offline IMAP folder hits the network.
 */
export const CHEAP_FIELDS = Object.freeze(['from', 'to', 'cc', 'subject', AGE_FIELD, ...STATE_FIELDS, TAG_FIELD]);

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

export function isStateCondition(condition) {
  return STATE_FIELDS.includes(foldCase(condition?.field));
}

export function isTagCondition(condition) {
  return foldCase(condition?.field) === TAG_FIELD;
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

/** Address-book ids a rule needs loaded before it can be evaluated. */
export function addressBookIdsOf(rule) {
  const ids = new Set();
  for (const c of rule?.conditions ?? []) {
    if (c?.operator === IN_ADDRESS_BOOK && typeof c.addressBookId === 'string' && c.addressBookId) {
      ids.add(c.addressBookId);
    }
  }
  return [...ids];
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

/**
 * Evaluate an address-book condition.
 *
 * NEVER matches, negated or not, when the book could not be read, is empty, or
 * the message names no usable address. "From is not in my address book" is
 * the shape people pair with Trash, and an unreadable book would otherwise
 * make every sender a stranger and empty the folder.
 */
function evaluateAddressBookCondition(message, condition, addressBooks) {
  const book = addressBooks?.get?.(condition.addressBookId);
  if (!(book instanceof Set) || book.size === 0) return false;

  const addresses = fieldsOf(condition)
    .flatMap((field) => valuesFor(message, field))
    .flatMap((value) => addressesFromHeaderValue(value))
    .map(normalizeAddress)
    .filter(Boolean);
  if (addresses.length === 0) return false;

  const anyKnown = addresses.some((a) => book.has(a));
  return condition.negate ? !anyKnown : anyKnown;
}

/**
 * Evaluate a read, star, or junk condition. NEVER matches, negated or not,
 * when the message does not carry the state as a boolean: an unknown state
 * must not read as "unread" or "not junk" and hand the message to an action.
 */
function evaluateStateCondition(message, condition) {
  const value = message?.state?.[foldCase(condition.field)];
  if (typeof value !== 'boolean') return false;

  let satisfied;
  if (condition.operator === STATE_OPERATORS.isOn) satisfied = value;
  else if (condition.operator === STATE_OPERATORS.isOff) satisfied = !value;
  else throw new Error(`Unknown state operator: ${condition.operator}`);
  return condition.negate ? !satisfied : satisfied;
}

/**
 * Evaluate a tag condition. NEVER matches, negated or not, when no tag is
 * chosen or the message's tags are unknown. "Does not have tag X" with a blank
 * X would otherwise be true for every message.
 */
function evaluateTagCondition(message, condition) {
  if (condition.operator !== HAS_TAG) throw new Error(`Unknown tag operator: ${condition.operator}`);
  const key = typeof condition.tagKey === 'string' ? condition.tagKey.trim() : '';
  if (!key || !Array.isArray(message?.tags)) return false;

  const satisfied = message.tags.includes(key);
  return condition.negate ? !satisfied : satisfied;
}

function evaluateNameCondition(message, condition) {
  const anySatisfied = fieldsOf(condition)
    .flatMap((field) => valuesFor(message, field))
    .flatMap((value) => addressesFromHeaderValue(value))
    .some(nameShowsOtherAddress);
  return condition.negate ? !anySatisfied : anySatisfied;
}

export function evaluateCondition(message, condition, { now = new Date(), addressBooks } = {}) {
  if (isAgeCondition(condition)) return evaluateAgeCondition(message, condition, now);
  if (isStateCondition(condition)) return evaluateStateCondition(message, condition);
  if (isTagCondition(condition)) return evaluateTagCondition(message, condition);
  if (condition.operator === IN_ADDRESS_BOOK) {
    return evaluateAddressBookCondition(message, condition, addressBooks);
  }
  if (condition.operator === DOMAIN_IN_LIST) return evaluateDomainCondition(message, condition);
  if (condition.operator === NAME_SHOWS_OTHER_ADDRESS) return evaluateNameCondition(message, condition);

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
