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
      current = { name: kv.value, enabled: true, type: '', condition: '', actions: [] };
      filters.push(current);
    } else if (current) {
      if (kv.key === 'enabled') {
        current.enabled = kv.value.toLowerCase() !== 'no';
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
      if (ch === '\\' && inQuotes && i + 1 < text.length) {
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
      if (ch === '\\' && quoted && i + 1 < inner.length) {
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
    const value = parts[2];
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
 * Extract `{ accountHints, path }` from a Thunderbird folder URI such as
 * `imap://user%40gmail.com@imap.gmail.com/Archive/2026` or
 * `mailbox://nobody@Local%20Folders/Work`.
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

  const accountHints = [];
  const at = authority.lastIndexOf('@');
  if (at > 0) {
    const user = safeDecode(authority.slice(0, at)).trim();
    const host = safeDecode(authority.slice(at + 1)).trim();
    if (user && user.toLowerCase() !== 'nobody') accountHints.push(user.toLowerCase());
    if (host) accountHints.push(host.toLowerCase());
  } else if (authority) {
    accountHints.push(safeDecode(authority).trim().toLowerCase());
  }
  return { accountHints, path };
}

/** Match a Thunderbird folder URI to a folder in the current profile, or null. */
export function resolveThunderbirdFolderUri(uri, knownFolders) {
  if (!Array.isArray(knownFolders) || knownFolders.length === 0) return null;
  const parsed = parseThunderbirdFolderUri(uri);
  if (!parsed) return null;
  const { accountHints, path } = parsed;
  const pathLower = path.toLowerCase();

  const matchesAccount = (folder) => {
    const name = String(folder?.accountName ?? '').trim().toLowerCase();
    return name && accountHints.some((h) => name === h || name.includes(h) || h.includes(name));
  };

  const exactByAccount = knownFolders.filter((f) => f?.path === path && matchesAccount(f));
  if (exactByAccount.length === 1) return exactByAccount[0];

  const ciByAccount = knownFolders.filter(
    (f) => String(f?.path ?? '').toLowerCase() === pathLower && matchesAccount(f),
  );
  if (ciByAccount.length === 1) return ciByAccount[0];

  const exactPath = knownFolders.filter((f) => f?.path === path);
  if (exactPath.length === 1) return exactPath[0];

  const ciPath = knownFolders.filter((f) => String(f?.path ?? '').toLowerCase() === pathLower);
  if (ciPath.length === 1) return ciPath[0];

  return null;
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
    const useMb = kb >= 1024 && kb % 1024 === 0;
    const size = useMb ? kb / 1024 : kb;
    const unit = useMb ? 'MB' : 'KB';
    if (op === 'is greater than') return { field: SIZE_FIELD, operator: SIZE_OPERATORS.largerThan, size, unit, negate: false };
    if (op === 'is less than') return { field: SIZE_FIELD, operator: SIZE_OPERATORS.smallerThan, size, unit, negate: false };
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
    if (op === 'contains' || op === 'is') return { field: TAG_FIELD, operator: HAS_TAG, tagKey, negate: false };
    if (op === "doesn't contain" || op === "isn't") return { field: TAG_FIELD, operator: HAS_TAG, tagKey, negate: true };
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

  // Junk status
  if (lowerField === 'junk status') {
    const junkVal = val.trim().toLowerCase();
    if ((op === 'is' && (junkVal === 'junk' || junkVal === '100')) || (op === "isn't" && junkVal === 'good')) {
      return { field: 'junk', operator: STATE_OPERATORS.isOn, negate: false };
    }
    if ((op === "isn't" && (junkVal === 'junk' || junkVal === '100')) || (op === 'is' && junkVal === 'good')) {
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

  const mappedOp = STRING_OPERATOR_MAP[op];
  if (!mappedOp) {
    problems.push(t('import_tbUnsupportedCondition', where, `${clause.field} ${op}`));
    return null;
  }
  if (val === '') {
    problems.push(t('import_emptyValue', where));
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
        continue;
      }
      mapped.push({ type: 'tag', tagKey: value });
    } else if (lower === 'junkscore') {
      if (value === '100') mapped.push({ type: 'markJunk' });
      else if (value === '0') mapped.push({ type: 'markNotJunk' });
      else problems.push(t('import_tbUnsupportedAction', where, `${kind} (${value})`));
    } else {
      problems.push(t('import_tbUnsupportedAction', where, kind));
    }
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
    if (!actions) continue;

    const rule = {
      name: name || t('import_defaultRuleName'),
      enabled: filter.enabled !== false,
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
