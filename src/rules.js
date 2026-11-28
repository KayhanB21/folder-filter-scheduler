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
import {
  OPERATORS,
  DOMAIN_IN_LIST,
  FIELDS,
  AGE_FIELD,
  AGE_OPERATORS,
  SIZE_FIELD,
  SIZE_OPERATORS,
  IN_ADDRESS_BOOK,
  NAME_SHOWS_OTHER_ADDRESS,
  STATE_FIELDS,
  STATE_OPERATORS,
  TAG_FIELD,
  HAS_TAG,
  PRIORITY_FIELD,
  PRIORITY_IS,
  PRIORITY_LEVELS,
  AUTH_FIELD,
  AUTH_PASSES,
  AUTH_METHODS,
  BODY_FIELD,
  ageDays,
  isCustomHeaderField,
  normalizeHeaderName,
  sizeAmount,
  sizeBytes,
  sizeUnit,
} from './matcher.js';
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
  ...Object.keys(SIZE_OPERATORS),
  ...Object.keys(STATE_OPERATORS),
  HAS_TAG,
  PRIORITY_IS,
  AUTH_PASSES,
]);
const AGE_OPERATOR_SET = new Set(Object.keys(AGE_OPERATORS));
const SIZE_OPERATOR_SET = new Set(Object.keys(SIZE_OPERATORS));

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
      } else if (SIZE_OPERATOR_SET.has(shape.operator)) {
        shape.bytes = sizeBytes(c);
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
    // Only when set, so rules without stop-processing keep their prior fingerprint.
    ...(rule?.stopProcessing === true ? { stopProcessing: true } : {}),
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

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Synchronous pure-JS SHA-256 hex digest (FIPS 180-4) so exports stay sync and dependency-free. */
function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667; let h1 = 0xbb67ae85; let h2 = 0x3c6ef372; let h3 = 0xa54ff53a;
  let h4 = 0x510e527f; let h5 = 0x9b05688c; let h6 = 0x1f83d9ab; let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0; let b = h1; let c = h2; let d = h3;
    let e = h4; let f = h5; let g = h6; let h = h7;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

/** Privacy-preserving account fingerprint for portable folder matching across computers. */
export function accountHash(accountName) {
  const norm = String(accountName ?? '').trim().toLowerCase();
  return norm ? sha256Hex(`ffs-account-v1:${norm}`).slice(0, 16) : '';
}

/**
 * Portable folder metadata for every folder referenced by a rule or action.
 * Stores a hashed account identifier alongside the folder path so exports
 * reconnect folders across computers without writing plain-text account names
 * (often email addresses) into `folderRefs`.
 */
function buildFolderRefs(rules, folders) {
  if (!Array.isArray(folders) || folders.length === 0) return null;
  const byId = new Map(folders.filter((f) => f?.id && f?.path).map((f) => [String(f.id), f]));
  const refs = {};
  const record = (id) => {
    const key = String(id ?? '');
    if (!key || refs[key]) return;
    const folder = byId.get(key);
    if (!folder) return;
    refs[key] = { accountHash: accountHash(folder.accountName), path: String(folder.path) };
  };
  for (const rule of rules ?? []) {
    for (const id of rule?.folderIds ?? []) record(id);
    for (const action of actionsOf(rule)) {
      if (action?.folderId) record(action.folderId);
    }
  }
  return Object.keys(refs).length > 0 ? refs : null;
}

/** The object written to a .json export. Run state is deliberately excluded. */
export function buildExport(config, { exportedAt = new Date(), folders } = {}) {
  const rules = (config?.rules ?? []).map((rule) => ({
    // Informational only: import recomputes it rather than trusting the file.
    hash: ruleHash(rule),
    name: rule.name,
    enabled: rule.enabled !== false,
    match: rule.match === 'all' ? 'all' : 'any',
    folderIds: [...(rule.folderIds ?? [])],
    includeSubfolders: rule.includeSubfolders === true,
    ...(rule.stopProcessing === true ? { stopProcessing: true } : {}),
    // Only when the rule has one, so files without schedules look as before.
    ...(rule.schedule ? { schedule: sanitizeSchedule(rule.schedule) } : {}),
    conditions: (rule.conditions ?? []).map((c) => ({ ...c })),
    actions: actionsOf(rule).map((a) => ({ ...a })),
  }));
  const folderRefs = buildFolderRefs(rules, folders);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    intervalMinutes: config?.intervalMinutes ?? 10,
    advanced: sanitizeAdvanced(config?.advanced).settings,
    allowlist: config?.allowlist ?? [...DEFAULT_ALLOWLIST],
    ...(folderRefs ? { folderRefs } : {}),
    rules,
  };
}

function sanitizeFields(raw, problems, where) {
  const listed = Array.isArray(raw?.fields) && raw.fields.length > 0
    ? raw.fields
    : [raw?.field].filter(Boolean);
  const fields = [];
  for (const entry of listed) {
    const lower = String(entry ?? '').trim().toLowerCase();
    if (KNOWN_FIELDS.has(lower)) {
      fields.push(lower);
    } else {
      const custom = normalizeHeaderName(entry);
      if (custom) fields.push(custom);
    }
  }

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

  // Size is a pseudo-field with its own operators too.
  const sizeField = fields.length === 1 && fields[0] === SIZE_FIELD;
  const sizeOperator = SIZE_OPERATOR_SET.has(operator);
  if (sizeField !== sizeOperator) {
    problems.push(t('import_operatorMismatch', where, operator, fields.join(',')));
    return null;
  }
  if (sizeField) {
    const size = sizeAmount(raw);
    const unit = sizeUnit(raw);
    if (size === null || unit === null) {
      problems.push(t('import_sizeValue', where));
      return null;
    }
    condition.size = size;
    condition.unit = unit;
    return condition;
  }

  // Read, star, junk, tag, priority, and auth are pseudo-fields too, each with
  // its own operators. One of them never shares a condition with another field.
  // Body and arbitrary custom headers take only the string operators, and never
  // share a condition with another field either.
  const [only] = fields;
  const stateField = fields.length === 1 && STATE_FIELDS.includes(only);
  const tagField = fields.length === 1 && only === TAG_FIELD;
  const priorityField = fields.length === 1 && only === PRIORITY_FIELD;
  const authField = fields.length === 1 && only === AUTH_FIELD;
  const bodyField = fields.length === 1 && only === BODY_FIELD;
  const customField = fields.length === 1 && isCustomHeaderField(only);
  const isPseudo = (f) =>
    STATE_FIELDS.includes(f) ||
    [AGE_FIELD, SIZE_FIELD, TAG_FIELD, PRIORITY_FIELD, AUTH_FIELD, BODY_FIELD].includes(f) ||
    isCustomHeaderField(f);
  const mixed = fields.length > 1 && fields.some(isPseudo);
  if (
    mixed ||
    stateField !== (operator in STATE_OPERATORS) ||
    tagField !== (operator === HAS_TAG) ||
    priorityField !== (operator === PRIORITY_IS) ||
    authField !== (operator === AUTH_PASSES) ||
    ((bodyField || customField) && !Object.hasOwn(OPERATORS, operator))
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
 * Resolve an imported folder id against the current profile's folders.
 *
 * When `folderRefs` carries metadata for the folder, we verify that even an
 * existing id (`account1://Spam`) belongs to the same account and path rather
 * than a different account that happens to sit in slot 1 on this computer. If
 * the id differs or belongs to another account, we reconnect ONLY when BOTH
 * the account hash (or legacy account name) AND folder path match uniquely,
 * never guessing across accounts.
 */
function resolveImportedFolder(folderId, { known, knownFolders, folderRefs }) {
  const id = String(folderId ?? '');
  if (!known) return { id, remapped: false, missing: false };

  const ref = folderRefs && typeof folderRefs === 'object' ? folderRefs[id] : null;
  const refPath = typeof ref?.path === 'string' ? ref.path : '';
  const wantedHash =
    typeof ref?.accountHash === 'string' && ref.accountHash
      ? ref.accountHash
      : typeof ref?.accountName === 'string' && ref.accountName
        ? accountHash(ref.accountName)
        : '';

  const hasFolders = Array.isArray(knownFolders) && knownFolders.length > 0;
  if (known.has(id)) {
    // Legacy export (no folderRefs): keep the id as before.
    if (!refPath || !hasFolders) return { id, remapped: false, missing: false };
    const direct = knownFolders.find((f) => String(f?.id) === id);
    if (
      direct &&
      String(direct.path ?? '').toLowerCase() === refPath.toLowerCase() &&
      (!wantedHash || accountHash(direct.accountName) === wantedHash)
    ) {
      return { id, remapped: false, missing: false };
    }
    // `id` exists on this profile, but points at a different account or path
    // than the export recorded, so fall through to reconnect by account + path.
  }

  if (refPath && wantedHash && hasFolders) {
    const exactAccount = knownFolders.filter(
      (f) => accountHash(f?.accountName) === wantedHash && f?.path === refPath,
    );
    if (exactAccount.length === 1) {
      const matchedId = String(exactAccount[0].id);
      return { id: matchedId, remapped: matchedId !== id, missing: false };
    }
    const ciAccount = knownFolders.filter(
      (f) =>
        accountHash(f?.accountName) === wantedHash &&
        String(f?.path ?? '').toLowerCase() === refPath.toLowerCase(),
    );
    if (ciAccount.length === 1) {
      const matchedId = String(ciAccount[0].id);
      return { id: matchedId, remapped: matchedId !== id, missing: false };
    }
  }

  return { id: null, remapped: false, missing: true };
}

/**
 * Rebuild a rule's action list field by field, in execution order.
 *
 * At most one terminal action survives. A rule that both moved and trashed the
 * same message would fail on the second step, because the first invalidates the
 * message ids, so the extras are dropped here and reported rather than left to
 * throw during a scheduled run. If a move or copy destination folder is missing
 * from this profile, the entire rule is skipped so "Copy to Archive, then
 * Delete" can never silently degrade into "Delete only".
 */
function sanitizeActions(raw, problems, where, folderContext) {
  const listed = actionsOf(raw);
  if (listed.length === 0) {
    problems.push(t('import_noAction', where));
    return null;
  }

  const actions = [];
  let terminal = null;
  let missingDestFolder = false;
  for (const candidate of orderActions(listed)) {
    const def = ACTIONS_BY_ID[candidate?.type];
    if (!def) {
      problems.push(t('import_unknownAction', where, candidate?.type ?? ''));
      continue;
    }
    let resolvedFolderId = null;
    if (def.needsFolder) {
      if (!candidate.folderId) {
        problems.push(t('import_needsFolder', where, def.id));
        continue;
      }
      const resolved = resolveImportedFolder(candidate.folderId, folderContext);
      if (resolved.missing) {
        problems.push(t('import_unknownActionFolder', where, def.id));
        missingDestFolder = true;
        continue;
      }
      if (resolved.remapped) folderContext.remapped += 1;
      resolvedFolderId = resolved.id;
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
    if (def.needsFolder) action.folderId = resolvedFolderId;
    if (def.needsTag) action.tagKey = String(candidate.tagKey);
    // Exact repeats are noise, not a mistake worth reporting.
    if (actions.some((a) => a.type === action.type && a.folderId === action.folderId && a.tagKey === action.tagKey)) {
      continue;
    }
    actions.push(action);
  }

  if (missingDestFolder) return null;
  if (actions.length === 0) {
    problems.push(t('import_noUsableAction', where));
    return null;
  }
  return actions;
}

function sanitizeRule(raw, index, problems, folderContext, knownAddressBookIds) {
  const where = raw?.name ? t('import_whereNamedRule', index + 1, raw.name) : t('import_whereRule', index + 1);

  const actions = sanitizeActions(raw, problems, where, folderContext);
  if (!actions) return null;

  const rawConditions = Array.isArray(raw?.conditions) ? raw.conditions : [];
  const conditions = rawConditions
    .map((c, i) => sanitizeCondition(c, problems, t('import_whereCondition', where, i + 1), knownAddressBookIds))
    .filter(Boolean);

  // A rule with no usable conditions is dropped rather than imported inert.
  if (conditions.length === 0) {
    problems.push(t('import_noConditions', where));
    return null;
  }
  const match = raw?.match === 'all' ? 'all' : 'any';
  // Dropping a condition from an "all" (AND) rule widens what it matches; skip
  // the whole rule instead of staging a broader destructive filter.
  if (match === 'all' && conditions.length < rawConditions.length) {
    problems.push(t('import_skippedWidened', where));
    return null;
  }

  const rawFolderIds = Array.isArray(raw?.folderIds) ? raw.folderIds.map(String) : [];
  let folderIds = rawFolderIds;
  if (folderContext.known) {
    const resolvedIds = [];
    const seenIds = new Set();
    let missingCount = 0;
    for (const id of rawFolderIds) {
      const resolved = resolveImportedFolder(id, folderContext);
      if (resolved.missing) {
        missingCount += 1;
        continue;
      }
      if (resolved.remapped) folderContext.remapped += 1;
      if (!seenIds.has(resolved.id)) {
        seenIds.add(resolved.id);
        resolvedIds.push(resolved.id);
      }
    }
    if (missingCount > 0) {
      problems.push(plural('import_unknownFolders', missingCount, where, missingCount));
    }
    folderIds = resolvedIds;
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
    ...(raw?.stopProcessing === true ? { stopProcessing: true } : {}),
    ...(schedule && schedule.cron ? { schedule } : {}),
    conditions,
    actions,
  };
}

/**
 * Validate a parsed export file. Returns the rules worth keeping plus a
 * human-readable list of everything that was rejected and why.
 */
export function sanitizeImport(
  data,
  { knownFolderIds, knownFolders, knownAddressBookIds, existingRules } = {},
) {
  const problems = [];
  const duplicates = [];
  const empty = {
    rules: [],
    duplicates,
    allowlist: null,
    intervalMinutes: null,
    advanced: null,
    remappedFolders: 0,
  };

  if (!data || typeof data !== 'object') {
    return { ...empty, problems: [t('import_notAnObject')] };
  }
  if (data.format && data.format !== EXPORT_FORMAT) {
    problems.push(t('import_unexpectedFormat', data.format));
  }
  if (!Array.isArray(data.rules)) {
    return { ...empty, problems: [...problems, t('import_noRules')] };
  }

  const folderIdList = knownFolderIds ?? (Array.isArray(knownFolders) ? knownFolders.map((f) => f.id) : null);
  const folderContext = {
    known: folderIdList ? new Set(folderIdList.map(String)) : null,
    knownFolders: Array.isArray(knownFolders) ? knownFolders : null,
    folderRefs: data.folderRefs && typeof data.folderRefs === 'object' ? data.folderRefs : null,
    remapped: 0,
  };
  const knownBooks = knownAddressBookIds ? new Set(knownAddressBookIds) : null;

  // Fingerprint what is already present so re-importing the same file is a
  // no-op rather than a way to accumulate duplicate rules.
  const seen = new Map();
  for (const rule of existingRules ?? []) {
    seen.set(ruleFingerprint(rule), rule.name ?? t('import_anExistingRule'));
  }

  const rules = [];
  for (const [i, raw] of data.rules.entries()) {
    const rule = sanitizeRule(raw, i, problems, folderContext, knownBooks);
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

  return {
    rules,
    duplicates,
    allowlist,
    intervalMinutes,
    advanced,
    remappedFolders: folderContext.remapped,
    problems,
  };
}

/**
 * Create an unsaved duplicate of a rule with no `id` (so saving assigns a
 * fresh identity and does not share run state with the original).
 */
export function duplicateRule(rule, copyName = (name) => t('rule_copyName', name)) {
  const baseName = String(rule?.name ?? '').trim() || t('common_untitledRule');
  return {
    name: copyName(baseName),
    enabled: rule?.enabled !== false,
    match: rule?.match === 'all' ? 'all' : 'any',
    folderIds: [...(rule?.folderIds ?? [])],
    includeSubfolders: rule?.includeSubfolders === true,
    ...(rule?.stopProcessing === true ? { stopProcessing: true } : {}),
    ...(rule?.schedule ? { schedule: { ...rule.schedule } } : {}),
    conditions: (rule?.conditions ?? []).map((c) => ({
      ...c,
      ...(Array.isArray(c?.fields) ? { fields: [...c.fields] } : {}),
      ...(Array.isArray(c?.domains) ? { domains: [...c.domains] } : {}),
    })),
    actions: actionsOf(rule).map((a) => ({ ...a })),
  };
}

/**
 * Whether a rule matches the options-page search filter.
 *
 * Every whitespace-separated word must appear somewhere in the rule's name,
 * condition fields/values/domains, action types/tags, or folder labels
 * (case-insensitive).
 */
export function ruleMatchesSearch(rule, query, { folderLabelsById, tagLabelsByKey, extraText = '' } = {}) {
  const words = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  const parts = [rule?.name ?? '', extraText];
  for (const id of rule?.folderIds ?? []) {
    parts.push(folderLabelsById?.get?.(id) ?? id);
  }
  for (const c of rule?.conditions ?? []) {
    if (Array.isArray(c?.fields)) parts.push(...c.fields);
    if (c?.field) parts.push(c.field);
    if (c?.operator) parts.push(c.operator);
    if (c?.value != null) parts.push(String(c.value));
    if (Array.isArray(c?.domains)) parts.push(...c.domains);
    if (c?.tagKey) parts.push(tagLabelsByKey?.get?.(c.tagKey) ?? c.tagKey);
    if (c?.days != null) parts.push(String(c.days));
    if (c?.size != null) parts.push(`${c.size} ${c.unit ?? ''}`);
  }
  for (const a of actionsOf(rule)) {
    if (a?.type) parts.push(a.type, ACTIONS_BY_ID[a.type]?.label ?? '');
    if (a?.folderId) parts.push(folderLabelsById?.get?.(a.folderId) ?? a.folderId);
    if (a?.tagKey) parts.push(tagLabelsByKey?.get?.(a.tagKey) ?? a.tagKey);
  }
  const haystack = parts.join(' ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}
