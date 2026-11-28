/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Parser and importer for Thunderbird's built-in `msgFilterRules.dat` files.
 *
 * Pure and free of extension APIs, like rules.js and matcher.js, so the whole
 * conversion is unit-testable under plain Node.
 *
 * Thunderbird stores each account's filters in a plain-text `msgFilterRules.dat`
 * file (`version="9"`, `name="..."`, `enabled="yes"`, `action="..."`,
 * `actionValue="..."`, `condition="AND (...) AND (...)"`). Converted rules are
 * staged on the options page for review and never stored until the user presses
 * Save. Anything unsupported is reported cleanly instead of silently dropped or
 * turned into a match-all rule.
 */

import { ACTIONS_BY_ID, orderActions } from './actions.js';
import { ALL_ADDRESS_BOOKS } from './contacts.js';
import { t } from './i18n.js';
import {
  AGE_FIELD,
  AGE_OPERATORS,
  BODY_FIELD,
  HAS_TAG,
  IN_ADDRESS_BOOK,
  PRIORITY_FIELD,
  PRIORITY_IS,
  SIZE_FIELD,
  SIZE_OPERATORS,
  STATE_OPERATORS,
  TAG_FIELD,
  TO_CC_FIELD,
  ageDays,
  normalizeHeaderName,
  priorityLevel,
  compilePattern,
} from './matcher.js';
import { ruleFingerprint, ruleHash } from './rules.js';

const STRING_FIELD_MAP = Object.freeze({
  from: 'from',
  to: 'to',
  cc: 'cc',
  'to or cc': TO_CC_FIELD,
  subject: 'subject',
  body: BODY_FIELD,
  'reply-to': 'reply-to',
  'list-id': 'list-id',
  sender: 'sender',
});

const ADDRESS_FIELD_SET = new Set(['from', 'to', 'cc', TO_CC_FIELD, 'reply-to', 'sender']);

/** The fields and operators that Thunderbird compares address by address. */
const PER_ADDRESS_FIELDS = new Set(['from', 'to', 'cc', TO_CC_FIELD]);
const PER_ADDRESS_OPERATORS = new Set(['is', "isn't", 'begins with', 'ends with']);

/**
 * The bits of a filter's `type` that make Thunderbird run it by itself: on
 * incoming mail (0x1, 0x2), on news (0x4, 0x8), after junk classification
 * (0x20), or on a timer (0x100). The other bits are "run manually" (0x10),
 * "after sending" (0x40), and "before archiving" (0x80).
 */
const AUTOMATIC_TYPE_BITS = 0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x100;

const STRING_OPERATOR_MAP = Object.freeze({
  contains: { operator: 'contains', negate: false },
  "doesn't contain": { operator: 'contains', negate: true },
  is: { operator: 'is', negate: false },
  "isn't": { operator: 'is', negate: true },
  'begins with': { operator: 'startsWith', negate: false },
  'ends with': { operator: 'endsWith', negate: false },
  matches: { operator: 'matchesRegex', negate: false },
  "doesn't match": { operator: 'matchesRegex', negate: true },
});

const PRIORITY_NUMBER_MAP = Object.freeze({
  6: 'highest',
  5: 'high',
  4: 'normal',
  3: 'low',
  2: 'lowest',
});

function isSingleQuotedValue(str) {
  if (str.length < 2 || str[0] !== '"' || str[str.length - 1] !== '"') return false;
  let escaped = false;
  for (let i = 1; i < str.length - 1; i += 1) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (str[i] === '\\') escaped = true;
    else if (str[i] === '"') return false;
  }
  return !escaped;
}

/** Unescape Thunderbird's `\"` and `\\` inside a quoted value, keeping other backslashes (like `\d`) intact. */
function unescapeQuoted(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && (text[i + 1] === '"' || text[i + 1] === '\\')) {
      i += 1;
      out += text[i];
    } else {
      out += text[i];
    }
  }
  return out;
}

/** True when `text` looks like a Thunderbird `msgFilterRules.dat` file rather than JSON. */
export function isThunderbirdFilterFile(text) {
  const cleaned = String(text ?? '').replace(/^\uFEFF/, '').trimStart();
  if (!cleaned || cleaned.startsWith('{') || cleaned.startsWith('[')) return false;
  return (
    (/^version="[^"]*"/m.test(cleaned) && (/^name="/m.test(cleaned) || /^logging="/m.test(cleaned))) ||
    (/^name="/m.test(cleaned) && /^condition="/m.test(cleaned))
  );
}

/** Parse one `key="value"` line, preserving escaped quotes inside the value. */
function parseKeyValueLine(line) {
  const eq = line.indexOf('=');
  if (eq <= 0) return null;
  const key = line.slice(0, eq).trim();
  const rest = line.slice(eq + 1).trim();
  if (!rest.startsWith('"') || !rest.endsWith('"') || rest.length < 2) return null;
  return { key, value: unescapeQuoted(rest.slice(1, -1)) };
}

/**
 * Parse a `msgFilterRules.dat` text into raw filter blocks:
 * `{ version, logging, filters: [{ name, enabled, type, condition, actions: [{ type, value }] }] }`.
 */
export function parseThunderbirdFilters(text) {
  const cleaned = String(text ?? '').replace(/^\uFEFF/, '');
  const lines = cleaned.split(/\r?\n/);
  let version = null;
  let logging = null;
  const filters = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const kv = parseKeyValueLine(line);
    if (!kv) continue;

    if (kv.key === 'version' && current === null) {
      version = kv.value;
    } else if (kv.key === 'logging' && current === null) {
      logging = kv.value;
    } else if (kv.key === 'name') {
      // Thunderbird enables a filter only on the exact value `yes`, and a
      // filter without the line is off.
      current = { name: kv.value, enabled: false, type: '', condition: '', actions: [] };
      filters.push(current);
    } else if (current) {
      if (kv.key === 'enabled') {
        current.enabled = kv.value === 'yes';
      } else if (kv.key === 'type') {
        current.type = kv.value;
      } else if (kv.key === 'condition') {
        current.condition = kv.value;
      } else if (kv.key === 'action') {
        current.actions.push({ type: kv.value, value: '' });
      } else if (kv.key === 'actionValue' && current.actions.length > 0) {
        current.actions[current.actions.length - 1].value = kv.value;
      }
    }
  }

  return { version, logging, filters };
}

/**
 * Split one Thunderbird `condition` string into `{ mode: 'all' | 'any' | 'ALL', clauses }`.
 *
 * Clauses are written `AND (field,operator,value) AND (...)` or `OR (...)`.
 * Custom header names inside a clause are double-quoted (`"List-Unsubscribe"`),
 * and values may legally contain commas or parentheses, so we locate each
 * clause boundary by finding the `)` followed by end-of-string or the next
 * `AND (` / `OR (` delimiter.
 */
export function parseThunderbirdCondition(conditionStr) {
  const text = String(conditionStr ?? '').trim();
  if (!text) return { mode: null, clauses: [] };
  if (text.toUpperCase() === 'ALL') return { mode: 'ALL', clauses: [] };

  let mode = null;
  let mixed = false;
  const clauses = [];
  let pos = 0;

  while (pos < text.length) {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    if (pos >= text.length) break;

    const rest = text.slice(pos);
    const conj = /^(AND|OR)\s*\(/i.exec(rest);
    if (!conj) return { mode: null, clauses: [], error: true };

    const word = conj[1].toUpperCase();
    const expected = word === 'AND' ? 'all' : 'any';
    if (mode === null) mode = expected;
    else if (mode !== expected) mixed = true;
    pos += conj[0].length;

    // Scan forward to the `)` that terminates this clause: either at the end of
    // the condition string, or immediately before `\s+(AND|OR)\s*\(`.
    let end = -1;
    let inQuotes = false;
    for (let i = pos; i < text.length; i += 1) {
      const ch = text[i];
      // Thunderbird writes a quote inside an unquoted value as `\"`.
      if (ch === '\\' && i + 1 < text.length && (inQuotes || text[i + 1] === '"')) {
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      if (!inQuotes && ch === ')') {
        const after = text.slice(i + 1);
        if (/^\s*$/.test(after) || /^\s+(?:AND|OR)\s*\(/i.test(after)) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return { mode: null, clauses: [], error: true };

    const inner = text.slice(pos, end);
    pos = end + 1;

    // Split on the first two unquoted commas: field, operator, value.
    const parts = [];
    let start = 0;
    let quoted = false;
    for (let i = 0; i < inner.length && parts.length < 2; i += 1) {
      const ch = inner[i];
      if (ch === '\\' && i + 1 < inner.length && (quoted || inner[i + 1] === '"')) {
        i += 1;
        continue;
      }
      if (ch === '"') {
        quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        parts.push(inner.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(inner.slice(start));
    if (parts.length !== 3) return { mode: null, clauses: [], error: true };

    let rawField = parts[0].trim();
    let customQuoted = false;
    if (rawField.startsWith('"') && rawField.endsWith('"') && rawField.length >= 2) {
      rawField = unescapeQuoted(rawField.slice(1, -1)).trim();
      customQuoted = true;
    }
    const operator = parts[1].trim().toLowerCase();
    // Thunderbird wraps a condition value in double quotes when it contains
    // `)` or starts/ends with whitespace (e.g. `"(urgent)"` or `" note"`).
    let value = parts[2];
    const trimmedVal = value.trim();
    if (isSingleQuotedValue(trimmedVal)) {
      value = unescapeQuoted(trimmedVal.slice(1, -1));
    } else {
      value = value.replaceAll('\\"', '"');
    }
    clauses.push({ field: rawField, customQuoted, operator, value });
  }

  return { mode, mixed, clauses };
}

function safeDecode(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Extract `{ username, host, path }` from a Thunderbird folder URI such as
 * `imap://user%40gmail.com@imap.gmail.com/Archive/2026` or
 * `mailbox://nobody@Local%20Folders/Work`.
 *
 * `nobody` is Thunderbird's placeholder for accounts without a login username
 * (such as Local Folders), so it is normalised to `username: ''`.
 */
export function parseThunderbirdFolderUri(uri) {
  const raw = String(uri ?? '').trim();
  const match = /^[a-z0-9+.-]+:\/\/([^/]*)(\/.*)$/i.exec(raw);
  if (!match) return null;
  const authority = match[1];
  const decodedSegments = match[2]
    .split('/')
    .filter(Boolean)
    .map(safeDecode);
  if (decodedSegments.length === 0) return null;
  const path = `/${decodedSegments.join('/')}`;

  let username = '';
  let host = '';
  const at = authority.lastIndexOf('@');
  if (at > 0) {
    const rawUser = safeDecode(authority.slice(0, at)).trim().toLowerCase();
    username = rawUser && rawUser !== 'nobody' ? rawUser : '';
    host = safeDecode(authority.slice(at + 1)).trim().toLowerCase();
  } else if (authority) {
    host = safeDecode(authority).trim().toLowerCase();
  }
  return { username, host, path };
}

/**
 * Match a Thunderbird folder URI to a folder in the current profile, or null.
 *
 * When the URI carries a username (e.g. `work@gmail.com` or `alice`), it is
 * matched against the account's identity email addresses (or exact account name
 * only when identity emails are unavailable), never against the mail server
 * host alone, so two Gmail accounts cannot collide. Host matching is allowed
 * only when the URI has no username, as with `mailbox://nobody@Local%20Folders`.
 */
export function resolveThunderbirdFolderUri(uri, knownFolders) {
  if (!Array.isArray(knownFolders) || knownFolders.length === 0) return null;
  const parsed = parseThunderbirdFolderUri(uri);
  if (!parsed) return null;
  const { username, host, path } = parsed;
  const pathLower = path.toLowerCase();

  const pickByPath = (candidates) => {
    const exact = candidates.filter((f) => f?.path === path);
    if (exact.length === 1) return exact[0];
    const ci = candidates.filter((f) => String(f?.path ?? '').toLowerCase() === pathLower);
    return ci.length === 1 ? ci[0] : null;
  };

  const emailsOf = (folder) =>
    Array.isArray(folder?.accountEmails)
      ? folder.accountEmails.map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean)
      : [];

  // The folders of one account only, or null when the candidates span several
  // accounts and `preferred` doesn't single one out. An address can be an
  // extra identity of another account, and a path that exists only there must
  // not receive the mail.
  const accountOf = (f) => String(f?.accountId ?? f?.accountName ?? '');
  const oneAccount = (candidates, preferred) => {
    const accounts = new Set(candidates.map(accountOf));
    if (accounts.size <= 1) return candidates;
    const chosen = new Set(candidates.filter(preferred).map(accountOf));
    return chosen.size === 1 ? candidates.filter((f) => chosen.has(accountOf(f))) : null;
  };

  if (username) {
    // 1. Exact identity email match (authoritative regardless of display name).
    //    The account whose default identity is the login address wins.
    const byExactEmail = oneAccount(
      knownFolders.filter((f) => emailsOf(f).includes(username)),
      (f) => emailsOf(f)[0] === username,
    );
    if (byExactEmail === null) return null;
    if (byExactEmail.length > 0) return pickByPath(byExactEmail);

    // 2. Local-part login + server host matching the identity email's domain
    //    (e.g. `imap://alice@mail.company.com/...` -> `alice@company.com`).
    if (!username.includes('@') && host) {
      const byLocalAndHost = knownFolders.filter((f) =>
        emailsOf(f).some((email) => {
          const split = email.lastIndexOf('@');
          if (split <= 0) return false;
          const local = email.slice(0, split);
          const domain = email.slice(split + 1);
          return local === username && (host === domain || host.endsWith(`.${domain}`));
        }),
      );
      if (byLocalAndHost.length > 0) return pickByPath(byLocalAndHost);
    }

    // 3. Fallback when a folder carries no identity emails: exact account name
    //    match against the username only (never host or substring matching).
    const byExactName = knownFolders.filter(
      (f) => emailsOf(f).length === 0 && String(f?.accountName ?? '').trim().toLowerCase() === username,
    );
    return pickByPath(byExactName);
  }

  if (!host) return null;

  // Host-only URIs (such as `mailbox://nobody@Local%20Folders/...`): match by
  // exact account name, or Thunderbird's `none` account type for Local Folders
  // (which works even when "Local Folders" is localised).
  const byHost = knownFolders.filter((f) => {
    const name = String(f?.accountName ?? '').trim().toLowerCase();
    if (name === host) return true;
    return host === 'local folders' && String(f?.accountType ?? '').toLowerCase() === 'none';
  });
  return pickByPath(byHost);
}

function convertClause(clause, where, problems) {
  const lowerField = clause.field.toLowerCase();
  const op = clause.operator;
  const val = clause.value;

  // Age in days
  if (lowerField === 'age in days') {
    const days = ageDays({ days: val.trim() });
    if (days === null) {
      problems.push(t('import_ageDays', where));
      return null;
    }
    if (op === 'is greater than') return { field: AGE_FIELD, operator: AGE_OPERATORS.olderThan, days, negate: false };
    if (op === 'is less than') return { field: AGE_FIELD, operator: AGE_OPERATORS.newerThan, days, negate: false };
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
    return null;
  }

  // Size (Thunderbird stores filter sizes in KB)
  if (lowerField === 'size') {
    const kb = Number(val.trim());
    if (!Number.isFinite(kb) || kb <= 0) {
      problems.push(t('import_sizeValue', where));
      return null;
    }
    const sized = (amountKb, operator) => {
      const useMb = amountKb >= 1024 && amountKb % 1024 === 0;
      return {
        field: SIZE_FIELD,
        operator,
        size: useMb ? amountKb / 1024 : amountKb,
        unit: useMb ? 'MB' : 'KB',
        negate: false,
      };
    };
    if (op === 'is greater than') return sized(kb, SIZE_OPERATORS.largerThan);
    if (op === 'is less than') return sized(kb, SIZE_OPERATORS.smallerThan);
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
    return null;
  }

  // Tag (or legacy `keyword`)
  if (lowerField === 'tag' || lowerField === 'keyword') {
    const tagKey = val.trim();
    if (!tagKey) {
      problems.push(t('import_noTag', where));
      return null;
    }
    // Thunderbird's "is" means the message has this tag and no other tag, which
    // a tag condition here can't say. Only "contains" converts.
    if (op === 'contains') return { field: TAG_FIELD, operator: HAS_TAG, tagKey, negate: false };
    if (op === "doesn't contain") return { field: TAG_FIELD, operator: HAS_TAG, tagKey, negate: true };
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
    return null;
  }

  // Priority
  if (lowerField === 'priority') {
    const level = PRIORITY_NUMBER_MAP[val.trim()] ?? priorityLevel(val);
    if (!level) {
      problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op} ${val}`));
      return null;
    }
    if (op === 'is') return { field: PRIORITY_FIELD, operator: PRIORITY_IS, value: level, negate: false };
    if (op === "isn't") return { field: PRIORITY_FIELD, operator: PRIORITY_IS, value: level, negate: true };
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
    return null;
  }

  // Status (read / flagged)
  if (lowerField === 'status') {
    const statusVal = val.trim().toLowerCase();
    const isPositive = op === 'is';
    const isNegative = op === "isn't";
    if ((isPositive || isNegative) && (statusVal === 'read' || statusVal === 'flagged')) {
      const field = statusVal === 'read' ? 'read' : 'star';
      return { field, operator: isPositive ? STATE_OPERATORS.isOn : STATE_OPERATORS.isOff, negate: false };
    }
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op} ${val}`));
    return null;
  }

  // Junk status (Thunderbird writes "2" for Junk and "1" for Good/Not Junk)
  if (lowerField === 'junk status') {
    const junkVal = val.trim().toLowerCase();
    const isJunkValue = junkVal === '2' || junkVal === 'junk' || junkVal === '100';
    const isGoodValue = junkVal === '1' || junkVal === 'good';
    if ((op === 'is' && isJunkValue) || (op === "isn't" && isGoodValue)) {
      return { field: 'junk', operator: STATE_OPERATORS.isOn, negate: false };
    }
    if ((op === "isn't" && isJunkValue) || (op === 'is' && isGoodValue)) {
      return { field: 'junk', operator: STATE_OPERATORS.isOff, negate: false };
    }
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op} ${val}`));
    return null;
  }

  // Standard header fields, body, or custom headers
  let targetField = STRING_FIELD_MAP[lowerField] ?? null;
  if (!targetField) {
    // Reject known TB non-header pseudo-fields instead of turning them into custom headers.
    const unsupportedBuiltins = new Set([
      'date',
      'all addresses',
      'attachment status',
      'folder info',
      'junk percent',
      'junk score origin',
      'other header',
    ]);
    if (!clause.customQuoted && unsupportedBuiltins.has(lowerField)) {
      problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
      return null;
    }
    targetField = normalizeHeaderName(clause.field);
  }
  if (!targetField) {
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
    return null;
  }

  // Address-book checks on address-bearing fields
  if (op === 'is in ab' || op === "isn't in ab") {
    if (!ADDRESS_FIELD_SET.has(targetField)) {
      problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
      return null;
    }
    problems.push(t('import_tbBookMappedAll', where));
    return {
      field: targetField,
      operator: IN_ADDRESS_BOOK,
      addressBookId: ALL_ADDRESS_BOOKS,
      negate: op === "isn't in ab",
    };
  }

  // Empty / non-empty checks translate cleanly to `^$` regex
  if (op === 'is empty' || op === "isn't empty") {
    return {
      field: targetField,
      operator: 'matchesRegex',
      value: '^$',
      negate: op === "isn't empty",
    };
  }

  const mappedOp = Object.hasOwn(STRING_OPERATOR_MAP, op) ? STRING_OPERATOR_MAP[op] : null;
  if (!mappedOp) {
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
    return null;
  }
  // On an address field, Thunderbird compares these operators with each
  // address and each display name. A condition here compares the whole header
  // text, so "From isn't boss@example.com" would match mail from
  // "Boss <boss@example.com>", and a filter that deletes would delete it.
  if (!clause.customQuoted && PER_ADDRESS_FIELDS.has(targetField) && PER_ADDRESS_OPERATORS.has(op)) {
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
    return null;
  }
  if (val === '') {
    problems.push(t('import_emptyValue', where));
    return null;
  }
  if (mappedOp.operator === 'matchesRegex' && compilePattern(val) === null) {
    problems.push(t('import_invalidRegex', where));
    return null;
  }
  return {
    field: targetField,
    operator: mappedOp.operator,
    negate: mappedOp.negate,
    value: val,
  };
}

function convertActions(rawActions, where, knownFolders, problems) {
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    problems.push(t('import_noAction', where));
    return { actions: null, stopProcessing: false };
  }

  const mapped = [];
  let stopProcessing = false;
  let missingDestFolder = false;
  let droppedAction = false;
  for (const raw of rawActions) {
    const kind = String(raw?.type ?? '').trim();
    const value = String(raw?.value ?? '').trim();
    const lower = kind.toLowerCase();

    if (lower === 'stop execution') {
      stopProcessing = true;
      continue;
    }
    if (lower === 'move to folder' || lower === 'copy to folder') {
      const type = lower === 'move to folder' ? 'move' : 'copy';
      const folder = resolveThunderbirdFolderUri(value, knownFolders);
      if (!folder) {
        const parsed = parseThunderbirdFolderUri(value);
        problems.push(t('import_tbMissingFolder', where, kind, parsed?.path ?? value));
        missingDestFolder = true;
        continue;
      }
      mapped.push({ type, folderId: String(folder.id) });
    } else if (lower === 'delete') {
      mapped.push({ type: 'trash' });
    } else if (lower === 'archive') {
      mapped.push({ type: 'archive' });
    } else if (lower === 'mark read') {
      mapped.push({ type: 'markRead' });
    } else if (lower === 'mark unread') {
      mapped.push({ type: 'markUnread' });
    } else if (lower === 'mark flagged') {
      mapped.push({ type: 'markFlagged' });
    } else if (lower === 'addtag') {
      if (!value) {
        problems.push(t('import_needsTag', where, 'tag'));
        droppedAction = true;
        continue;
      }
      mapped.push({ type: 'tag', tagKey: value });
    } else if (lower === 'junkscore') {
      if (value === '100') mapped.push({ type: 'markJunk' });
      else if (value === '0') mapped.push({ type: 'markNotJunk' });
      else {
        problems.push(t('import_tbUnsupportedAction', where, `${kind} (${value})`));
        droppedAction = true;
      }
    } else {
      problems.push(t('import_tbUnsupportedAction', where, kind));
      droppedAction = true;
    }
  }

  // Never keep a partial rule when Copy or Move lost its destination folder:
  // "Copy to Archive, then Delete" must never turn into "Delete only".
  if (missingDestFolder) {
    return { actions: null, stopProcessing };
  }

  // Enforce execution order and at most one terminal action, matching rules.js.
  const actions = [];
  let terminal = null;
  for (const candidate of orderActions(mapped)) {
    const def = ACTIONS_BY_ID[candidate.type];
    if (!def) continue;
    if (def.terminal) {
      if (terminal) {
        problems.push(t('import_secondTerminal', where, def.id, terminal));
        continue;
      }
      terminal = def.id;
    }
    if (actions.some((a) => a.type === candidate.type && a.folderId === candidate.folderId && a.tagKey === candidate.tagKey)) {
      continue;
    }
    actions.push(candidate);
  }

  if (actions.length === 0) {
    problems.push(t('import_noUsableAction', where));
    return { actions: null, stopProcessing };
  }
  // "Forward, then Delete" must never turn into "Delete only": when an action
  // was dropped and the rest still removes mail from the folder, skip the rule.
  if (droppedAction && terminal) {
    problems.push(t('import_skippedDroppedAction', where));
    return { actions: null, stopProcessing };
  }
  return { actions, stopProcessing };
}

/**
 * Convert a Thunderbird `msgFilterRules.dat` file into staged FFS rules.
 *
 * Returns the same shape as `sanitizeImport` so the options page can handle
 * both formats through one staged review path.
 */
export function importThunderbirdFilters(text, { knownFolders = [], existingRules = [] } = {}) {
  const problems = [];
  const duplicates = [];
  const parsed = parseThunderbirdFilters(text);

  if (parsed.filters.length === 0) {
    return {
      rules: [],
      duplicates,
      allowlist: null,
      intervalMinutes: null,
      advanced: null,
      remappedFolders: 0,
      problems: [t('import_tbNoFilters')],
    };
  }

  const seen = new Map();
  for (const rule of existingRules ?? []) {
    seen.set(ruleFingerprint(rule), rule.name ?? t('import_anExistingRule'));
  }

  const rules = [];
  for (const [i, filter] of parsed.filters.entries()) {
    const name = String(filter.name ?? '').trim();
    const where = name ? t('import_whereNamedRule', i + 1, name) : t('import_whereRule', i + 1);

    const { actions, stopProcessing } = convertActions(filter.actions, where, knownFolders, problems);
    const condParsed = parseThunderbirdCondition(filter.condition);

    if (condParsed.mode === 'ALL') {
      problems.push(t('import_tbMatchAllUnsupported', where));
      continue;
    }
    if (condParsed.error || condParsed.clauses.length === 0) {
      problems.push(t('import_tbBadCondition', where));
      continue;
    }
    if (condParsed.mixed) {
      problems.push(t('import_tbMixedLogic', where));
    }

    const conditions = condParsed.clauses
      .map((clause, ci) => convertClause(clause, t('import_whereCondition', where, ci + 1), problems))
      .filter(Boolean);

    if (conditions.length === 0) {
      problems.push(t('import_noConditions', where));
      continue;
    }
    // Dropping a condition from an AND rule widens what it matches (e.g.
    // "From boss AND date before 2020 -> Delete" would become "From boss ->
    // Delete"). Skip the rule instead of staging a broader destructive filter.
    if (condParsed.mode === 'all' && conditions.length < condParsed.clauses.length) {
      problems.push(t('import_tbSkippedWidened', where));
      continue;
    }
    if (!actions) continue;

    // A filter that Thunderbird runs only by hand, after sending, or before
    // archiving would run on a timer here, so it is imported turned off.
    const typeBits = Number.parseInt(filter.type, 10);
    const automatic = !Number.isFinite(typeBits) || (typeBits & AUTOMATIC_TYPE_BITS) !== 0;
    if (!automatic && filter.enabled === true) problems.push(t('import_tbNotAutomatic', where));

    const rule = {
      name: name || t('import_defaultRuleName'),
      enabled: filter.enabled === true && automatic,
      match: condParsed.mode === 'all' ? 'all' : 'any',
      // msgFilterRules.dat does not name the source folder; the user picks
      // which folder(s) to watch on the options page before saving.
      folderIds: [],
      includeSubfolders: false,
      ...(stopProcessing ? { stopProcessing: true } : {}),
      conditions,
      actions,
    };

    const fingerprint = ruleFingerprint(rule);
    if (seen.has(fingerprint)) {
      duplicates.push({ name: rule.name, hash: ruleHash(rule), matches: seen.get(fingerprint) });
      continue;
    }
    seen.set(fingerprint, rule.name);
    rules.push(rule);
  }

  return {
    rules,
    duplicates,
    allowlist: null,
    intervalMinutes: null,
    advanced: null,
    remappedFolders: 0,
    problems,
  };
}
