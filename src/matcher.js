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
 * `date`, `size` (bytes), `state` (read, star, junk), and `tags` for the
 * conditions that are not about a header, `headersRead`, true when the full
 * headers were downloaded and are in `fields`, `auth`, the SPF, DKIM, and DMARC
 * results when a rule needs them, and `body`, the text of each text part of
 * the message as a string array when a rule needs it.
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

const compiledPatterns = new Map();

/**
 * The compiled, case-insensitive regex for a pattern, or null when JavaScript
 * can't compile it. A pattern from another regex dialect, such as `(?i)spam`,
 * is the usual cause. Compiled one time for each pattern.
 */
export function compilePattern(pattern) {
  const source = String(pattern ?? '');
  if (!compiledPatterns.has(source)) {
    let regex = null;
    try {
      regex = new RegExp(source, 'i');
    } catch {
      regex = null;
    }
    compiledPatterns.set(source, regex);
  }
  return compiledPatterns.get(source);
}

/** Operators are positive predicates; negation is a separate flag on a condition. */
export const OPERATORS = Object.freeze({
  contains: (value, needle) => value.includes(needle),
  is: (value, needle) => value.trim() === needle.trim(),
  startsWith: (value, needle) => value.startsWith(needle),
  endsWith: (value, needle) => value.endsWith(needle),
  // A bad pattern must never crash a scheduled run: it is "no match" here, and
  // `unusableValue` keeps a negated condition from turning that into a match.
  matchesRegex: (value, needle) => compilePattern(needle)?.test(value) ?? false,
});

/** The operator's predicate, or undefined. Never a method of Object.prototype. */
const predicateFor = (operator) =>
  (typeof operator === 'string' && Object.hasOwn(OPERATORS, operator) ? OPERATORS[operator] : undefined);

/**
 * True when a text condition has a value that can't decide anything, so the
 * condition NEVER matches, negated or not:
 *
 * - A blank value with `contains`, `startsWith`, `endsWith`, or `matchesRegex`.
 *   Every text contains the empty text, so the condition would be true for
 *   every message, and a rule that matches any condition would then act on a
 *   whole folder. `is` with a blank value stays: it means "is empty".
 * - A regex that doesn't compile. It matches nothing, and its negated form
 *   would match every message.
 */
export function unusableValue(condition) {
  const value = String(condition?.value ?? '');
  if (condition?.operator === 'matchesRegex') return value === '' || compilePattern(value) === null;
  return value === '' && condition?.operator !== 'is';
}

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
 * The combined recipient field: reads both `to` and `cc` from the indexed
 * message with zero downloads. Matches when any address or header value in
 * either `to` or `cc` satisfies the condition.
 */
export const TO_CC_FIELD = 'to-cc';

/**
 * Sentinel option value used by the options UI for arbitrary custom headers
 * (e.g. `X-Spam-Status`, `List-Unsubscribe`, `Return-Path`). Stored rules hold
 * the actual lowercased header name in `condition.field`, never this sentinel.
 */
export const CUSTOM_HEADER_OPTION = 'custom-header';

/**
 * The message-size pseudo-field. Not a header: it compares `message.size`
 * (bytes, read for free from Thunderbird's indexed MessageHeader) against a
 * user threshold in KB or MB. Shape:
 * `{ field: 'size', operator: 'largerThan' | 'smallerThan', size: N, unit: 'KB' | 'MB', negate }`.
 */
export const SIZE_FIELD = 'size';
export const SIZE_OPERATORS = Object.freeze({
  largerThan: 'largerThan',
  smallerThan: 'smallerThan',
});
export const SIZE_UNITS = Object.freeze(['KB', 'MB']);
const SIZE_UNIT_BYTES = Object.freeze({ KB: 1024, MB: 1024 * 1024 });

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

/**
 * The priority pseudo-field. Thunderbird does not index the priority for
 * add-ons, so it is read from the X-Priority header (or Priority, when that
 * is the only one), which costs a header download per message. A message with
 * neither header is Normal, as Thunderbird shows it. Shape:
 * `{ field: 'priority', operator: 'priorityIs', value: <level>, negate }`.
 */
export const PRIORITY_FIELD = 'priority';
export const PRIORITY_IS = 'priorityIs';
export const PRIORITY_LEVELS = Object.freeze(['highest', 'high', 'normal', 'low', 'lowest']);

/**
 * The SPF, DKIM, and DMARC pseudo-field. Shape:
 * `{ field: 'auth', operator: 'authPasses', value: <method>, negate }`.
 * background.js downloads the raw message and fills `message.auth` with
 * `pass`, `notPass`, or `unknown` for each method; see src/auth/check.js.
 */
export const AUTH_FIELD = 'auth';
export const AUTH_PASSES = 'authPasses';
export const AUTH_METHODS = Object.freeze(['spf', 'dkim', 'dmarc']);

/**
 * The body pseudo-field: the text of the message. It takes the string
 * operators, like a header. background.js reads the body only for a message
 * that the rule's other conditions leave undecided, and puts it in
 * `message.body`. Shape: `{ field: 'body', operator, value, negate }`.
 */
export const BODY_FIELD = 'body';

export const FIELDS = Object.freeze([
  'from',
  'to',
  'cc',
  TO_CC_FIELD,
  'subject',
  BODY_FIELD,
  'reply-to',
  'list-id',
  'sender',
  AGE_FIELD,
  SIZE_FIELD,
  ...STATE_FIELDS,
  TAG_FIELD,
  PRIORITY_FIELD,
  AUTH_FIELD,
]);

/**
 * Fields obtainable for free from a lightweight MessageHeader (author,
 * recipients, ccList, subject, date, size, read/flagged/junk, tags), that is,
 * without fetching the full message. Everything else (reply-to, list-id,
 * sender, arbitrary custom headers) needs a `messages.getHeaders()` /
 * `messages.getFull()`, which on a non-offline IMAP folder hits the network.
 */
export const CHEAP_FIELDS = Object.freeze([
  'from',
  'to',
  'cc',
  TO_CC_FIELD,
  'subject',
  AGE_FIELD,
  SIZE_FIELD,
  ...STATE_FIELDS,
  TAG_FIELD,
]);
const CHEAP_FIELD_SET = new Set(CHEAP_FIELDS);

const PSEUDO_FIELD_SET = new Set([
  AGE_FIELD,
  SIZE_FIELD,
  ...STATE_FIELDS,
  TAG_FIELD,
  PRIORITY_FIELD,
  AUTH_FIELD,
  BODY_FIELD,
]);
const KNOWN_FIELD_SET = new Set(FIELDS);
const HEADER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;

const foldCase = (s) => (s ?? '').toString().toLowerCase();

/**
 * Normalize an arbitrary email header name (e.g. `"List-Unsubscribe:"` ->
 * `"list-unsubscribe"`). Returns null when the name is blank, contains illegal
 * characters, or collides with a pseudo-field or UI sentinel.
 */
export function normalizeHeaderName(name) {
  const cleaned = String(name ?? '').trim().replace(/:+$/, '').trim().toLowerCase();
  if (!HEADER_NAME_RE.test(cleaned)) return null;
  if (PSEUDO_FIELD_SET.has(cleaned) || cleaned === TO_CC_FIELD || cleaned === CUSTOM_HEADER_OPTION) {
    return null;
  }
  return cleaned;
}

/** True when `field` names an arbitrary custom header (not a built-in field). */
export function isCustomHeaderField(field) {
  const cleaned = normalizeHeaderName(field);
  return cleaned !== null && !KNOWN_FIELD_SET.has(cleaned);
}

/**
 * True when the message explicitly marks full headers as unread
 * (`headersRead === false`) and this condition reads a non-cheap header.
 *
 * Defence in depth: `normalize()` already drops a message whose headers could
 * not be read, and this guard guarantees that even if unread headers ever reach
 * the matcher, a negated condition such as "Reply-To does not contain X" never
 * matches mail whose headers were not read. Messages that omit `headersRead`
 * (plain objects in unit tests) are unaffected.
 */
function needsUnreadHeader(message, condition) {
  if (message?.headersRead !== false) return false;
  const fields = fieldsOf(condition);
  return (fields.length > 0 ? fields : ['']).some((f) => !CHEAP_FIELD_SET.has(foldCase(f)));
}

/**
 * The header(s) a condition reads. `fields` (plural) lets one domain-list
 * condition watch both Reply-To and From, which matters because most spam
 * carries only one of the two. Falls back to the singular `field` so rules
 * written before this existed keep working.
 */
export function isAgeCondition(condition) {
  return foldCase(condition?.field) === AGE_FIELD;
}

export function isSizeCondition(condition) {
  return foldCase(condition?.field) === SIZE_FIELD;
}

export function isStateCondition(condition) {
  return STATE_FIELDS.includes(foldCase(condition?.field));
}

export function isTagCondition(condition) {
  return foldCase(condition?.field) === TAG_FIELD;
}

export function isPriorityCondition(condition) {
  return foldCase(condition?.field) === PRIORITY_FIELD;
}

export function isAuthCondition(condition) {
  return foldCase(condition?.field) === AUTH_FIELD;
}

export function isBodyCondition(condition) {
  return foldCase(condition?.field) === BODY_FIELD;
}

/**
 * One priority header value as a level, or null when it says nothing usable.
 * X-Priority is "1" to "5", often with a word after it: "1 (Highest)". Some
 * senders write only the word, and the Priority header uses "urgent" and
 * "non-urgent".
 */
export function priorityLevel(value) {
  const text = foldCase(value).trim();
  const digit = /^[1-5]/.exec(text);
  if (digit) return PRIORITY_LEVELS[Number(digit[0]) - 1];
  // The longer word before the shorter, and "non-urgent" before "urgent".
  if (text.includes('lowest')) return 'lowest';
  if (text.includes('non-urgent') || text.includes('low')) return 'low';
  if (text.includes('highest') || text.includes('urgent')) return 'highest';
  if (text.includes('high')) return 'high';
  if (text.includes('normal')) return 'normal';
  return null;
}

/** The priority of a normalized message: X-Priority, then Priority, then Normal. */
export function priorityOf(message) {
  for (const header of ['x-priority', 'priority']) {
    for (const value of valuesFor(message, header)) {
      const level = priorityLevel(value);
      if (level) return level;
    }
  }
  return 'normal';
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

/** The numeric threshold of a size condition, or null when unusable. */
export function sizeAmount(condition) {
  const raw = condition?.size;
  if (raw === '' || raw === null || raw === undefined || typeof raw === 'boolean') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The normalised unit (`KB` or `MB`) of a size condition, or null when unknown. */
export function sizeUnit(condition) {
  const unit = String(condition?.unit ?? '').trim().toUpperCase();
  return SIZE_UNITS.includes(unit) ? unit : null;
}

/** The threshold of a size condition in bytes, or null when unusable. */
export function sizeBytes(condition) {
  const amount = sizeAmount(condition);
  const unit = sizeUnit(condition);
  if (amount === null || unit === null) return null;
  return amount * SIZE_UNIT_BYTES[unit];
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
    // The raw download covers it, see requiresRaw.
    if (isAuthCondition(c)) return false;
    // The body read covers it, see requiresBody.
    if (isBodyCondition(c)) return false;
    // A condition naming no field at all is treated as expensive, erring toward
    // fetching rather than silently evaluating against nothing.
    const fields = fieldsOf(c);
    return (fields.length > 0 ? fields : ['']).some((f) => !cheap.has(foldCase(f)));
  });
}

/**
 * True when a rule checks SPF, DKIM, or DMARC, so the engine must download
 * the raw message.
 */
export function requiresRaw(rule) {
  return (rule?.conditions ?? []).some(isAuthCondition);
}

/** True when a rule checks the message body, so the engine might read it. */
export function requiresBody(rule) {
  return (rule?.conditions ?? []).some(isBodyCondition);
}

function valuesFor(message, field) {
  const key = foldCase(field);
  const fields = message && message.fields ? message.fields : {};
  if (key === TO_CC_FIELD) {
    return [
      ...(Array.isArray(fields.to) ? fields.to : []),
      ...(Array.isArray(fields.cc) ? fields.cc : []),
      ...(Array.isArray(fields[TO_CC_FIELD]) ? fields[TO_CC_FIELD] : []),
    ];
  }
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
  if (needsUnreadHeader(message, condition)) return false;
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
 * Evaluate a message-size condition. `message.size` is the message size in
 * bytes as Thunderbird indexed it. NEVER matches, negated or not, when the
 * threshold is unusable or `message.size` is missing or invalid.
 */
function evaluateSizeCondition(message, condition) {
  if (condition.operator !== SIZE_OPERATORS.largerThan && condition.operator !== SIZE_OPERATORS.smallerThan) {
    throw new Error(`Unknown size operator: ${condition.operator}`);
  }
  const threshold = sizeBytes(condition);
  const actual = message?.size;
  if (threshold === null || typeof actual !== 'number' || !Number.isFinite(actual) || actual < 0) {
    return false;
  }

  const satisfied =
    condition.operator === SIZE_OPERATORS.largerThan ? actual > threshold : actual < threshold;
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
  if (needsUnreadHeader(message, condition)) return false;
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

/**
 * Evaluate a priority condition. NEVER matches, negated or not, when the level
 * is not a known one, or when the message's headers were not read. Without its
 * headers every message looks like Normal, and "priority is normal" on a rule
 * that deletes would then act on mail it never read.
 */
function evaluatePriorityCondition(message, condition) {
  if (condition.operator !== PRIORITY_IS) throw new Error(`Unknown priority operator: ${condition.operator}`);
  const level = foldCase(condition.value).trim();
  if (!PRIORITY_LEVELS.includes(level) || message?.headersRead !== true) return false;

  const satisfied = priorityOf(message) === level;
  return condition.negate ? !satisfied : satisfied;
}

/**
 * Evaluate an SPF, DKIM, or DMARC condition. NEVER matches, negated or not,
 * when the method is unknown or the result is anything but pass or not pass.
 * A DNS error or a download that timed out leaves the result unknown, and
 * "DKIM does not pass" on a rule that deletes would otherwise act on mail it
 * never checked.
 */
function evaluateAuthCondition(message, condition) {
  if (condition.operator !== AUTH_PASSES) throw new Error(`Unknown auth operator: ${condition.operator}`);
  const method = foldCase(condition.value).trim();
  if (!AUTH_METHODS.includes(method)) return false;
  const result = message?.auth?.[method];
  if (result !== 'pass' && result !== 'notPass') return false;

  const satisfied = result === 'pass';
  return condition.negate ? !satisfied : satisfied;
}

/** Line breaks and runs of spaces as one space, so a phrase matches across a wrapped line. */
const collapseSpace = (s) => (s ?? '').toString().replace(/\s+/g, ' ').trim();

/**
 * Evaluate a body condition. Each text part is a value, like a repeated
 * header: a positive condition matches when any part satisfies it, a negated
 * one only when none does. NEVER matches, negated or not, when the body was
 * not read: "body does not contain X" on a rule that deletes would otherwise
 * act on mail it never read.
 */
function evaluateBodyCondition(message, condition) {
  if (!Array.isArray(message?.body)) return false;
  const predicate = predicateFor(condition.operator);
  if (!predicate) throw new Error(`Unknown body operator: ${condition.operator}`);
  if (unusableValue(condition)) return false;

  // A regex keeps the case of its pattern, as in evaluateCondition.
  const regex = condition.operator === 'matchesRegex';
  const fold = regex ? collapseSpace : (s) => foldCase(collapseSpace(s));
  const needle = fold(condition.value);
  const parts = message.body.length > 0 ? message.body : [''];
  const satisfied = parts.some((part) => predicate(fold(part), needle));
  return condition.negate ? !satisfied : satisfied;
}

function evaluateNameCondition(message, condition) {
  if (needsUnreadHeader(message, condition)) return false;
  const anySatisfied = fieldsOf(condition)
    .flatMap((field) => valuesFor(message, field))
    .flatMap((value) => addressesFromHeaderValue(value))
    .some(nameShowsOtherAddress);
  return condition.negate ? !anySatisfied : anySatisfied;
}

export function evaluateCondition(message, condition, { now = new Date(), addressBooks } = {}) {
  if (isAgeCondition(condition)) return evaluateAgeCondition(message, condition, now);
  if (isSizeCondition(condition)) return evaluateSizeCondition(message, condition);
  if (isStateCondition(condition)) return evaluateStateCondition(message, condition);
  if (isTagCondition(condition)) return evaluateTagCondition(message, condition);
  if (isPriorityCondition(condition)) return evaluatePriorityCondition(message, condition);
  if (isAuthCondition(condition)) return evaluateAuthCondition(message, condition);
  if (isBodyCondition(condition)) return evaluateBodyCondition(message, condition);
  if (condition.operator === IN_ADDRESS_BOOK) {
    return evaluateAddressBookCondition(message, condition, addressBooks);
  }
  if (condition.operator === DOMAIN_IN_LIST) return evaluateDomainCondition(message, condition);
  if (condition.operator === NAME_SHOWS_OTHER_ADDRESS) return evaluateNameCondition(message, condition);

  const predicate = predicateFor(condition.operator);
  if (!predicate) {
    throw new Error(`Unknown operator: ${condition.operator}`);
  }
  if (unusableValue(condition)) return false;
  // A blank or invalid header field (e.g. an unconfigured custom header) must
  // never match, even when negated.
  const fieldKey = foldCase(condition.field).trim();
  const resolvedField = fieldKey === TO_CC_FIELD ? TO_CC_FIELD : normalizeHeaderName(fieldKey);
  if (!resolvedField) return false;
  if (needsUnreadHeader(message, condition)) return false;
  // A regex gets the text and pattern unchanged. Its own `i` flag ignores case,
  // and folding the pattern would turn `\D` into `\d` and break `(?-i:...)`.
  const fold = condition.operator === 'matchesRegex' ? (s) => (s ?? '').toString() : foldCase;
  const needle = fold(condition.value);
  let values = valuesFor(message, resolvedField).map(fold);
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

/**
 * The result of a rule from its conditions other than the body, or null when
 * only the body can decide it. Lets the engine skip the body read: an "all"
 * rule with one false condition is false, and an "any" rule with one true
 * condition is true, whatever the body says.
 */
export function decideWithoutBody(message, rule, options = {}) {
  const conditions = rule && Array.isArray(rule.conditions) ? rule.conditions : [];
  if (conditions.length === 0) return false;

  const others = conditions.filter((c) => !isBodyCondition(c)).map((c) => evaluateCondition(message, c, options));
  if (rule.match === 'all') {
    if (others.some((r) => !r)) return false;
  } else if (others.some(Boolean)) {
    return true;
  }
  return conditions.some(isBodyCondition) ? null : evaluateRule(message, rule, options);
}
