/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Import and export of rule sets.
 *
 * Pure and free of extension APIs, like matcher.js and domains.js, so the
 * validation below is unit-testable under plain Node.
 *
 * Everything arriving through import is treated as untrusted: a rule file can
 * carry an action that deletes mail, so each rule is rebuilt field by field from
 * known-good values rather than merged in as-is. Anything unrecognised is
 * dropped and reported instead of being stored and quietly misbehaving later.
 * The options page shows those reports, so they come from the message catalog.
 */

import { ACTIONS_BY_ID, actionsOf, orderActions } from './actions.js';
import { OPERATORS, DOMAIN_IN_LIST, FIELDS, AGE_FIELD, AGE_OPERATORS, IN_ADDRESS_BOOK, NAME_SHOWS_OTHER_ADDRESS, STATE_FIELDS, STATE_OPERATORS, TAG_FIELD, HAS_TAG, PRIORITY_FIELD, PRIORITY_IS, PRIORITY_LEVELS, AUTH_FIELD, AUTH_PASSES, AUTH_METHODS, ageDays } from './matcher.js';
import { ADDRESS_BOOK_FIELDS, ALL_ADDRESS_BOOKS } from './contacts.js';
import { DEFAULT_ALLOWLIST, normalizeDomain, parseDomainList } from './domains.js';
import { sanitizeAdvanced } from './settings.js';
import { sanitizeSchedule, scheduleOf } from './cron.js';
import { plural, t } from './i18n.js';

export const EXPORT_FORMAT = 'folder-filter-scheduler/rules';
export const EXPORT_VERSION = 1;

const KNOWN_FIELDS = new Set(FIELDS);
const KNOWN_OPERATORS = new Set([
  ...Object.keys(OPERATORS),
  DOMAIN_IN_LIST,
  IN_ADDRESS_BOOK,
  NAME_SHOWS_OTHER_ADDRESS,
  ...Object.keys(AGE_OPERATORS),
  ...Object.keys(STATE_OPERATORS),
  HAS_TAG,
  PRIORITY_IS,
  AUTH_PASSES,
]);
const AGE_OPERATOR_SET = new Set(Object.keys(AGE_OPERATORS));

/**
 * A canonical string capturing what a rule *does*, ignoring cosmetics.
 *
 * Name and enabled state are excluded: renaming a rule does not make it a
 * different rule. Folder ids, conditions, domain lists, and multi-field sets are
 * all sorted, so two rules that behave identically fingerprint identically no
 * matter what order their parts were written in.
 */
export function ruleFingerprint(rule) {
  const conditions = (rule?.conditions ?? [])
    .map((c) => {
      const listed = Array.isArray(c?.fields) && c.fields.length > 0
        ? c.fields
        : [c?.field].filter(Boolean);
      const shape = {
        fields: listed.map((f) => String(f).toLowerCase()).sort(),
        operator: String(c?.operator ?? ''),
        negate: c?.negate === true,
      };
      if (c?.operator === DOMAIN_IN_LIST) {
        shape.domains = [...(c.domains ?? [])].map(normalizeDomain).filter(Boolean).sort();
      } else if (AGE_OPERATOR_SET.has(shape.operator)) {
        shape.days = ageDays(c);
      } else if (shape.operator === IN_ADDRESS_BOOK) {
        shape.addressBookId = String(c?.addressBookId ?? '');
      } else if (shape.operator === HAS_TAG) {
        shape.tagKey = String(c?.tagKey ?? '');
      } else if (shape.operator !== NAME_SHOWS_OTHER_ADDRESS && !(shape.operator in STATE_OPERATORS)) {
        shape.value = String(c?.value ?? '');
      }
      return JSON.stringify(shape, Object.keys(shape).sort());
    })
    .sort();

  // Sorted: within a rule the non-terminal actions commute, and the terminal
  // one is forced last at run time, so stored order carries no meaning.
  const actions = actionsOf(rule)
    .map((a) => {
      const shape = { type: String(a?.type ?? '') };
      if (a?.folderId) shape.folderId = String(a.folderId);
      if (a?.tagKey) shape.tagKey = String(a.tagKey);
      return JSON.stringify(shape, Object.keys(shape).sort());
    })
    .sort();

  return JSON.stringify({
    actions,
    conditions,
    folderIds: [...(rule?.folderIds ?? [])].map(String).sort(),
    // Only when set, so fingerprints of rules from before 0.3.5 do not change.
    ...(rule?.includeSubfolders === true ? { includeSubfolders: true } : {}),
    match: rule?.match === 'all' ? 'all' : 'any',
    // Only when the schedule is on, so a rule without one, or with one turned
    // off, fingerprints as it did before 0.3.6. Two rules that differ only in
    // when they run are different rules.
    ...(scheduleOf(rule) ? { schedule: scheduleOf(rule).expression } : {}),
  });
}

/**
 * Short, stable label for a rule's fingerprint (FNV-1a). Shown to the user when
 * an import is skipped. Duplicate detection compares the full fingerprint, not
 * this, so a hash collision cannot cause a rule to be wrongly discarded.
 */
export function ruleHash(rule) {
  let h = 0x811c9dc5;
  for (const ch of ruleFingerprint(rule)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Filename for an export, stamped with local date and time.
 *
 * Local rather than UTC because the user is naming a file on their own machine,
 * and the field order sorts chronologically in a file listing. No colons: they
 * are illegal in filenames on Windows and awkward elsewhere.
 */
export function exportFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `ffs-rules-${stamp}.json`;
}

/** The object written to a .json export. Run state is deliberately excluded. */
export function buildExport(config, { exportedAt = new Date() } = {}) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    intervalMinutes: config?.intervalMinutes ?? 10,
    advanced: sanitizeAdvanced(config?.advanced).settings,
    allowlist: config?.allowlist ?? [...DEFAULT_ALLOWLIST],
    rules: (config?.rules ?? []).map((rule) => ({
      // Informational only: import recomputes it rather than trusting the file.
      hash: ruleHash(rule),
      name: rule.name,
      enabled: rule.enabled !== false,
      match: rule.match === 'all' ? 'all' : 'any',
      folderIds: [...(rule.folderIds ?? [])],
      includeSubfolders: rule.includeSubfolders === true,
      // Only when the rule has one, so files without schedules look as before.
      ...(rule.schedule ? { schedule: sanitizeSchedule(rule.schedule) } : {}),
      conditions: (rule.conditions ?? []).map((c) => ({ ...c })),
      actions: actionsOf(rule).map((a) => ({ ...a })),
    })),
  };
}

function sanitizeFields(raw, problems, where) {
  const listed = Array.isArray(raw?.fields) && raw.fields.length > 0
    ? raw.fields
    : [raw?.field].filter(Boolean);
  const fields = listed.map((f) => String(f).toLowerCase()).filter((f) => KNOWN_FIELDS.has(f));

  if (fields.length === 0) {
    problems.push(t('import_noField', where));
    return null;
  }
  return fields;
}

function sanitizeCondition(raw, problems, where, knownAddressBookIds) {
  const operator = String(raw?.operator ?? '');
  if (!KNOWN_OPERATORS.has(operator)) {
    problems.push(t('import_unknownOperator', where, operator));
    return null;
  }

  const fields = sanitizeFields(raw, problems, where);
  if (!fields) return null;

  const condition = { operator, negate: raw?.negate === true };
  if (fields.length > 1) condition.fields = fields;
  else [condition.field] = fields;

  // Age is a pseudo-field with its own operators; the two must travel together.
  const ageField = fields.length === 1 && fields[0] === AGE_FIELD;
  const ageOperator = AGE_OPERATOR_SET.has(operator);
  if (ageField !== ageOperator) {
    problems.push(t('import_operatorMismatch', where, operator, fields.join(',')));
    return null;
  }
  if (ageField) {
    const days = ageDays(raw);
    if (days === null) {
      problems.push(t('import_ageDays', where));
      return null;
    }
    condition.days = days;
    return condition;
  }

  // Read, star, junk, tag, priority, and auth are pseudo-fields too, each with
  // its own operators. One of them never shares a condition with another field.
  const [only] = fields;
  const stateField = fields.length === 1 && STATE_FIELDS.includes(only);
  const tagField = fields.length === 1 && only === TAG_FIELD;
  const priorityField = fields.length === 1 && only === PRIORITY_FIELD;
  const authField = fields.length === 1 && only === AUTH_FIELD;
  const isPseudo = (f) => STATE_FIELDS.includes(f) || [TAG_FIELD, PRIORITY_FIELD, AUTH_FIELD].includes(f);
  const mixed = fields.length > 1 && fields.some(isPseudo);
  if (
    mixed ||
    stateField !== (operator in STATE_OPERATORS) ||
    tagField !== (operator === HAS_TAG) ||
    priorityField !== (operator === PRIORITY_IS) ||
    authField !== (operator === AUTH_PASSES)
  ) {
    problems.push(t('import_operatorMismatch', where, operator, fields.join(',')));
    return null;
  }
  if (stateField) return condition;
  if (tagField) {
    const tagKey = typeof raw?.tagKey === 'string' ? raw.tagKey.trim() : '';
    if (!tagKey) {
      problems.push(t('import_noTag', where));
      return null;
    }
    condition.tagKey = tagKey;
    return condition;
  }
  if (priorityField) {
    const level = String(raw?.value ?? '').trim().toLowerCase();
    if (!PRIORITY_LEVELS.includes(level)) {
      problems.push(t('import_priorityLevel', where, PRIORITY_LEVELS.join(', ')));
      return null;
    }
    condition.value = level;
    return condition;
  }
  if (authField) {
    const method = String(raw?.value ?? '').trim().toLowerCase();
    if (!AUTH_METHODS.includes(method)) {
      problems.push(t('import_authMethod', where, AUTH_METHODS.join(', ')));
      return null;
    }
    condition.value = method;
    return condition;
  }

  if (operator === IN_ADDRESS_BOOK) {
    if (!fields.every((f) => ADDRESS_BOOK_FIELDS.includes(f))) {
      problems.push(t('import_bookFields', where, ADDRESS_BOOK_FIELDS.join(', ')));
      return null;
    }
    const id = typeof raw?.addressBookId === 'string' ? raw.addressBookId.trim() : '';
    if (!id) {
      problems.push(t('import_noBook', where));
      return null;
    }
    // Book ids are per profile, like folder ids. An unknown one is kept, not
    // remapped: it never matches until the user picks a book, whereas quietly
    // widening it to "all" could turn a small blocklist book into every contact.
    if (id !== ALL_ADDRESS_BOOKS && knownAddressBookIds && !knownAddressBookIds.has(id)) {
      problems.push(t('import_unknownBook', where));
    }
    condition.addressBookId = id;
    return condition;
  }

  if (operator === NAME_SHOWS_OTHER_ADDRESS) {
    if (!fields.every((f) => ADDRESS_BOOK_FIELDS.includes(f))) {
      problems.push(t('import_nameFields', where, ADDRESS_BOOK_FIELDS.join(', ')));
      return null;
    }
    return condition;
  }

  if (operator === DOMAIN_IN_LIST) {
    // Re-validate every domain: an imported list must not be able to smuggle in
    // a blank or malformed entry that would match every message.
    const { domains, invalid } = parseDomainList((raw?.domains ?? []).join('\n'));
    if (invalid.length > 0) problems.push(plural('import_invalidDomains', invalid.length, where, invalid.length));
    if (domains.length === 0) {
      problems.push(t('import_emptyDomains', where));
      return null;
    }
    condition.domains = domains;
  } else {
    condition.value = String(raw?.value ?? '');
    if (condition.value === '') {
      problems.push(t('import_emptyValue', where));
      return null;
    }
  }
  return condition;
}

/**
 * Rebuild a rule's action list field by field, in execution order.
 *
 * At most one terminal action survives. A rule that both moved and trashed the
 * same message would fail on the second step, because the first invalidates the
 * message ids, so the extras are dropped here and reported rather than left to
 * throw during a scheduled run.
 */
function sanitizeActions(raw, problems, where) {
  const listed = actionsOf(raw);
  if (listed.length === 0) {
    problems.push(t('import_noAction', where));
    return null;
  }

  const actions = [];
  let terminal = null;
  for (const candidate of orderActions(listed)) {
    const def = ACTIONS_BY_ID[candidate?.type];
    if (!def) {
      problems.push(t('import_unknownAction', where, candidate?.type ?? ''));
      continue;
    }
    if (def.needsFolder && !candidate.folderId) {
      problems.push(t('import_needsFolder', where, def.id));
      continue;
    }
    if (def.needsTag && !candidate.tagKey) {
      problems.push(t('import_needsTag', where, def.id));
      continue;
    }
    if (def.terminal) {
      if (terminal) {
        problems.push(t('import_secondTerminal', where, def.id, terminal));
        continue;
      }
      terminal = def.id;
    }
    const action = { type: def.id };
    if (def.needsFolder) action.folderId = String(candidate.folderId);
    if (def.needsTag) action.tagKey = String(candidate.tagKey);
    // Exact repeats are noise, not a mistake worth reporting.
    if (actions.some((a) => a.type === action.type && a.folderId === action.folderId && a.tagKey === action.tagKey)) {
      continue;
    }
    actions.push(action);
  }

  if (actions.length === 0) {
    problems.push(t('import_noUsableAction', where));
    return null;
  }
  return actions;
}

function sanitizeRule(raw, index, problems, knownFolderIds, knownAddressBookIds) {
  const where = raw?.name ? t('import_whereNamedRule', index + 1, raw.name) : t('import_whereRule', index + 1);

  const actions = sanitizeActions(raw, problems, where);
  if (!actions) return null;

  const conditions = (Array.isArray(raw?.conditions) ? raw.conditions : [])
    .map((c, i) => sanitizeCondition(c, problems, t('import_whereCondition', where, i + 1), knownAddressBookIds))
    .filter(Boolean);

  // A rule with no usable conditions is dropped rather than imported inert.
  if (conditions.length === 0) {
    problems.push(t('import_noConditions', where));
    return null;
  }

  let folderIds = Array.isArray(raw?.folderIds) ? raw.folderIds.map(String) : [];
  if (knownFolderIds) {
    const missing = folderIds.filter((id) => !knownFolderIds.has(id));
    if (missing.length > 0) {
      problems.push(plural('import_unknownFolders', missing.length, where, missing.length));
      folderIds = folderIds.filter((id) => knownFolderIds.has(id));
    }
  }

  // A schedule that does not parse is kept as text but turned off, so the rule
  // falls back to the default timer and the user can correct it.
  let schedule = null;
  if (raw?.schedule && typeof raw.schedule === 'object') {
    schedule = sanitizeSchedule(raw.schedule);
    if (raw.schedule.enabled === true && !schedule.enabled) {
      problems.push(t('import_badSchedule', where));
    }
  }

  return {
    name: String(raw?.name ?? '').trim() || t('import_defaultRuleName'),
    // Imported rules always get fresh ids so they cannot collide with existing
    // rules or inherit another profile's run state.
    enabled: raw?.enabled !== false,
    match: raw?.match === 'all' ? 'all' : 'any',
    folderIds,
    includeSubfolders: raw?.includeSubfolders === true,
    ...(schedule && schedule.cron ? { schedule } : {}),
    conditions,
    actions,
  };
}

/**
 * Validate a parsed export file. Returns the rules worth keeping plus a
 * human-readable list of everything that was rejected and why.
 */
export function sanitizeImport(data, { knownFolderIds, knownAddressBookIds, existingRules } = {}) {
  const problems = [];
  const duplicates = [];
  const empty = { rules: [], duplicates, allowlist: null, intervalMinutes: null, advanced: null };

  if (!data || typeof data !== 'object') {
    return { ...empty, problems: [t('import_notAnObject')] };
  }
  if (data.format && data.format !== EXPORT_FORMAT) {
    problems.push(t('import_unexpectedFormat', data.format));
  }
  if (!Array.isArray(data.rules)) {
    return { ...empty, problems: [...problems, t('import_noRules')] };
  }

  const known = knownFolderIds ? new Set(knownFolderIds) : null;
  const knownBooks = knownAddressBookIds ? new Set(knownAddressBookIds) : null;

  // Fingerprint what is already present so re-importing the same file is a
  // no-op rather than a way to accumulate duplicate rules.
  const seen = new Map();
  for (const rule of existingRules ?? []) {
    seen.set(ruleFingerprint(rule), rule.name ?? t('import_anExistingRule'));
  }

  const rules = [];
  for (const [i, raw] of data.rules.entries()) {
    const rule = sanitizeRule(raw, i, problems, known, knownBooks);
    if (!rule) continue;

    const fingerprint = ruleFingerprint(rule);
    if (seen.has(fingerprint)) {
      duplicates.push({ name: rule.name, hash: ruleHash(rule), matches: seen.get(fingerprint) });
      continue;
    }
    seen.set(fingerprint, rule.name);
    rules.push(rule);
  }

  let allowlist = null;
  if (Array.isArray(data.allowlist)) {
    const parsed = parseDomainList(data.allowlist.join('\n'));
    allowlist = parsed.domains;
    if (parsed.invalid.length > 0) {
      problems.push(plural('import_invalidAllowlist', parsed.invalid.length, parsed.invalid.length));
    }
  }

  const interval = Number(data.intervalMinutes);
  const intervalMinutes = Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : null;

  // Absent in files written before 0.3.2, and left alone rather than reset to
  // defaults: an import should not quietly retune someone's scan engine.
  let advanced = null;
  if (data.advanced && typeof data.advanced === 'object') {
    const sanitized = sanitizeAdvanced(data.advanced);
    advanced = sanitized.settings;
    problems.push(...sanitized.problems.map((p) => t('import_advanced', p)));
  }

  return { rules, duplicates, allowlist, intervalMinutes, advanced, problems };
}
