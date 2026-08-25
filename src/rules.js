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
 */

import { ACTIONS_BY_ID } from './actions.js';
import { OPERATORS, DOMAIN_IN_LIST, FIELDS } from './matcher.js';
import { DEFAULT_ALLOWLIST, normalizeDomain, parseDomainList } from './domains.js';

export const EXPORT_FORMAT = 'folder-filter-scheduler/rules';
export const EXPORT_VERSION = 1;

const KNOWN_FIELDS = new Set(FIELDS);
const KNOWN_OPERATORS = new Set([...Object.keys(OPERATORS), DOMAIN_IN_LIST]);

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
      } else {
        shape.value = String(c?.value ?? '');
      }
      return JSON.stringify(shape, Object.keys(shape).sort());
    })
    .sort();

  const action = { type: String(rule?.action?.type ?? '') };
  if (rule?.action?.folderId) action.folderId = String(rule.action.folderId);

  return JSON.stringify({
    action,
    conditions,
    folderIds: [...(rule?.folderIds ?? [])].map(String).sort(),
    match: rule?.match === 'all' ? 'all' : 'any',
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

/** The object written to a .json export. Run state is deliberately excluded. */
export function buildExport(config) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    intervalMinutes: config?.intervalMinutes ?? 10,
    allowlist: config?.allowlist ?? [...DEFAULT_ALLOWLIST],
    rules: (config?.rules ?? []).map((rule) => ({
      // Informational only: import recomputes it rather than trusting the file.
      hash: ruleHash(rule),
      name: rule.name,
      enabled: rule.enabled !== false,
      match: rule.match === 'all' ? 'all' : 'any',
      folderIds: [...(rule.folderIds ?? [])],
      conditions: (rule.conditions ?? []).map((c) => ({ ...c })),
      action: { ...(rule.action ?? {}) },
    })),
  };
}

function sanitizeFields(raw, problems, where) {
  const listed = Array.isArray(raw?.fields) && raw.fields.length > 0
    ? raw.fields
    : [raw?.field].filter(Boolean);
  const fields = listed.map((f) => String(f).toLowerCase()).filter((f) => KNOWN_FIELDS.has(f));

  if (fields.length === 0) {
    problems.push(`${where}: no recognised header field`);
    return null;
  }
  return fields;
}

function sanitizeCondition(raw, problems, where) {
  const operator = String(raw?.operator ?? '');
  if (!KNOWN_OPERATORS.has(operator)) {
    problems.push(`${where}: unknown operator "${operator}"`);
    return null;
  }

  const fields = sanitizeFields(raw, problems, where);
  if (!fields) return null;

  const condition = { operator, negate: raw?.negate === true };
  if (fields.length > 1) condition.fields = fields;
  else [condition.field] = fields;

  if (operator === DOMAIN_IN_LIST) {
    // Re-validate every domain: an imported list must not be able to smuggle in
    // a blank or malformed entry that would match every message.
    const { domains, invalid } = parseDomainList((raw?.domains ?? []).join('\n'));
    if (invalid.length > 0) problems.push(`${where}: dropped ${invalid.length} invalid domain(s)`);
    if (domains.length === 0) {
      problems.push(`${where}: domain list is empty`);
      return null;
    }
    condition.domains = domains;
  } else {
    condition.value = String(raw?.value ?? '');
    if (condition.value === '') {
      problems.push(`${where}: empty value`);
      return null;
    }
  }
  return condition;
}

function sanitizeRule(raw, index, problems, knownFolderIds) {
  const where = `Rule ${index + 1}${raw?.name ? ` ("${raw.name}")` : ''}`;

  const action = ACTIONS_BY_ID[raw?.action?.type];
  if (!action) {
    problems.push(`${where}: unknown action "${raw?.action?.type ?? ''}", rule skipped`);
    return null;
  }
  if (action.needsFolder && !raw?.action?.folderId) {
    problems.push(`${where}: action needs a destination folder, rule skipped`);
    return null;
  }

  const conditions = (Array.isArray(raw?.conditions) ? raw.conditions : [])
    .map((c, i) => sanitizeCondition(c, problems, `${where} condition ${i + 1}`))
    .filter(Boolean);

  // A rule with no usable conditions is dropped rather than imported inert.
  if (conditions.length === 0) {
    problems.push(`${where}: no usable conditions, rule skipped`);
    return null;
  }

  let folderIds = Array.isArray(raw?.folderIds) ? raw.folderIds.map(String) : [];
  if (knownFolderIds) {
    const missing = folderIds.filter((id) => !knownFolderIds.has(id));
    if (missing.length > 0) {
      problems.push(`${where}: ${missing.length} folder(s) not in this profile, removed`);
      folderIds = folderIds.filter((id) => knownFolderIds.has(id));
    }
  }

  const rebuiltAction = { type: action.id };
  if (action.needsFolder) rebuiltAction.folderId = String(raw.action.folderId);

  return {
    name: String(raw?.name ?? '').trim() || 'Imported rule',
    // Imported rules always get fresh ids so they cannot collide with existing
    // rules or inherit another profile's run state.
    enabled: raw?.enabled !== false,
    match: raw?.match === 'all' ? 'all' : 'any',
    folderIds,
    conditions,
    action: rebuiltAction,
  };
}

/**
 * Validate a parsed export file. Returns the rules worth keeping plus a
 * human-readable list of everything that was rejected and why.
 */
export function sanitizeImport(data, { knownFolderIds, existingRules } = {}) {
  const problems = [];
  const duplicates = [];
  const empty = { rules: [], duplicates, allowlist: null, intervalMinutes: null };

  if (!data || typeof data !== 'object') {
    return { ...empty, problems: ['Not a valid JSON object'] };
  }
  if (data.format && data.format !== EXPORT_FORMAT) {
    problems.push(`Unexpected format "${data.format}"`);
  }
  if (!Array.isArray(data.rules)) {
    return { ...empty, problems: [...problems, 'No rules array found'] };
  }

  const known = knownFolderIds ? new Set(knownFolderIds) : null;

  // Fingerprint what is already present so re-importing the same file is a
  // no-op rather than a way to accumulate duplicate rules.
  const seen = new Map();
  for (const rule of existingRules ?? []) {
    seen.set(ruleFingerprint(rule), rule.name ?? 'an existing rule');
  }

  const rules = [];
  for (const [i, raw] of data.rules.entries()) {
    const rule = sanitizeRule(raw, i, problems, known);
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
      problems.push(`Allowlist: dropped ${parsed.invalid.length} invalid domain(s)`);
    }
  }

  const interval = Number(data.intervalMinutes);
  const intervalMinutes = Number.isFinite(interval) && interval >= 1 ? Math.floor(interval) : null;

  return { rules, duplicates, allowlist, intervalMinutes, problems };
}
