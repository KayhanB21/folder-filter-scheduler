/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Copy-action deduplication, kept in `storage.local`.
 *
 * Pure and free of extension APIs, like auth/cache.js: it takes and returns
 * plain objects, and background.js owns reading and writing storage.
 *
 * Why this exists. Copy is non-terminal: the original message stays in the
 * source folder after it is copied. Every incremental overlap scan (90 minutes
 * by default), every 30-minute catch-up scan (30 days by default), every age
 * rule, and every manual "Run all rules now" sees the same message again and
 * would otherwise copy it into the destination folder repeatedly.
 *
 * Keying. Entries are scoped by `(ruleId, destFolderId, messageKey)`:
 * - Changing a rule's copy destination to a different folder copies there fresh.
 * - Adding a second copy destination copies to the new folder without
 *   re-copying to the first.
 * - Deleting a rule or removing a copy destination prunes its history on the
 *   next run; disabling a rule keeps its history so re-enabling does not
 *   duplicate older mail.
 * - Each `messageKey` is a truncated SHA-256 hash of indexed header fields, so
 *   no addresses, subjects, or Message-IDs are stored in plain text.
 */

import { actionsOf } from './actions.js';

export const COPY_HISTORY_KEY = 'copyHistory';
/** Prefix for per-target sharded keys in `storage.local`. */
export const COPY_BUCKET_PREFIX = 'copyHistory:';
/** Max remembered copies per `(ruleId, destFolderId)` target. */
export const COPY_CAP_PER_TARGET = 50_000;

/** Storage key for one `(ruleId, destFolderId)` bucket so saving one rule never rewrites others. */
export function copyBucketKey(ruleId, destFolderId) {
  return `${COPY_BUCKET_PREFIX}${encodeURIComponent(String(ruleId))}:${encodeURIComponent(String(destFolderId))}`;
}

/** Parse a sharded `copyHistory:<ruleId>:<destId>` key back into `[ruleId, destId]`, or null. */
export function parseCopyBucketKey(key) {
  if (typeof key !== 'string' || !key.startsWith(COPY_BUCKET_PREFIX)) return null;
  const rest = key.slice(COPY_BUCKET_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  try {
    return [decodeURIComponent(rest.slice(0, sep)), decodeURIComponent(rest.slice(sep + 1))];
  } catch {
    return null;
  }
}

/**
 * Reassemble the nested `{ [ruleId]: { [destId]: bucket } }` map from a full
 * `storage.local.get(null)` dump, merging both sharded `copyHistory:*` keys and
 * any pre-sharding legacy `copyHistory` key.
 */
export function loadStoredCopyHistory(allStorage) {
  const merged = {};
  const legacy = allStorage?.[COPY_HISTORY_KEY];
  const hasLegacy = Boolean(legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0);
  const shardKeys = [];

  if (hasLegacy) {
    for (const [ruleId, byDest] of Object.entries(legacy)) {
      if (!byDest || typeof byDest !== 'object') continue;
      merged[ruleId] = {};
      for (const [destId, bucket] of Object.entries(byDest)) {
        if (bucket && typeof bucket === 'object') merged[ruleId][destId] = { ...bucket };
      }
    }
  }

  for (const [key, value] of Object.entries(allStorage ?? {})) {
    const parsed = parseCopyBucketKey(key);
    if (!parsed) continue;
    shardKeys.push(key);
    if (!value || typeof value !== 'object') continue;
    const [ruleId, destId] = parsed;
    merged[ruleId] ??= {};
    merged[ruleId][destId] = { ...(merged[ruleId][destId] ?? {}), ...value };
  }

  return { stored: merged, shardKeys, hasLegacy };
}

const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** True when a rule carries at least one usable copy action. */
export function hasCopyAction(rule) {
  return actionsOf(rule).some((a) => a?.type === 'copy' && Boolean(a.folderId));
}

/**
 * A stable, privacy-preserving key for a message from its indexed MessageHeader.
 *
 * Prefers `headerMessageId` (+ author, date, size) so the key survives restarts
 * and also deduplicates the same message appearing in multiple watched folders
 * (such as Gmail Inbox and All Mail). Falls back to folder + author + date +
 * size + subject when a message carries no Message-ID, returning null only when
 * none of those fields are present.
 */
export async function copyKeyOf(header, subtle = globalThis.crypto.subtle) {
  if (!header || typeof header !== 'object') return null;
  const date = header.date instanceof Date ? header.date.toISOString() : String(header.date ?? '');
  const id = String(header.headerMessageId ?? '').trim();
  let text;
  if (id) {
    text = ['id', id, header.author ?? '', date, header.size ?? ''].join('\n');
  } else {
    const parts = [
      header.folder?.id ?? '',
      header.author ?? '',
      date,
      header.size ?? '',
      header.subject ?? '',
    ];
    if (parts.every((p) => p === '')) return null;
    text = ['fallback', ...parts].join('\n');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(digest).slice(0, 32);
}

/** Active copy destination folders per rule id, including disabled rules. */
function copyTargetsByRule(rules) {
  const targets = new Map();
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule?.id) continue;
    const folders = new Set(
      actionsOf(rule)
        .filter((a) => a?.type === 'copy' && typeof a.folderId === 'string' && a.folderId)
        .map((a) => a.folderId),
    );
    if (folders.size > 0) targets.set(rule.id, folders);
  }
  return targets;
}

/** Trim one bucket to at most `cap` newest entries (newest insertion wins ties). Never mutates. */
function trimBucket(bucket, cap) {
  const valid = Object.entries(bucket ?? {}).filter(
    ([key, at]) => key && typeof at === 'number' && Number.isFinite(at),
  );
  let changed = valid.length !== Object.keys(bucket ?? {}).length;
  if (valid.length > cap) {
    valid.reverse().sort(([, a], [, b]) => b - a);
    valid.length = cap;
    changed = true;
  }
  return { bucket: Object.fromEntries(valid), changed };
}

/**
 * Drop entries for deleted rules, removed copy destinations, invalid records,
 * and anything past `cap` per destination. Never mutates `history`.
 *
 * When `rules` is null or omitted, only invalid records and entries past `cap`
 * are dropped.
 *
 * @param {object} history
 * @param {Array|null} [rules] full config rule list (enabled and disabled), or null
 * @param {number} [cap]
 * @returns {{ history: object, changed: boolean }}
 */
export function pruneCopyHistory(history, rules = null, cap = COPY_CAP_PER_TARGET) {
  const source = history && typeof history === 'object' ? history : {};
  const targets = Array.isArray(rules) ? copyTargetsByRule(rules) : null;
  const out = {};
  let changed = false;

  for (const [ruleId, byDest] of Object.entries(source)) {
    const allowedDests = targets ? targets.get(ruleId) : null;
    if ((targets && !allowedDests) || !byDest || typeof byDest !== 'object') {
      changed = true;
      continue;
    }
    const keptDests = {};
    for (const [destId, bucket] of Object.entries(byDest)) {
      if ((allowedDests && !allowedDests.has(destId)) || !bucket || typeof bucket !== 'object') {
        changed = true;
        continue;
      }
      const trimmed = trimBucket(bucket, cap);
      if (trimmed.changed) changed = true;
      if (Object.keys(trimmed.bucket).length > 0) keptDests[destId] = trimmed.bucket;
      else changed = true;
    }
    if (Object.keys(keptDests).length > 0) out[ruleId] = keptDests;
    else changed = true;
  }

  return { history: out, changed };
}

/**
 * Per-run copy history tracker.
 *
 * @param {object} options
 * @param {object} [options.stored] stored history from `storage.local`; never mutated
 * @param {Array|null} [options.rules] full config rule list for pruning stale entries
 * @param {() => number} [options.now]
 * @param {number} [options.cap]
 * @param {SubtleCrypto} [options.subtle]
 */
export function createCopyHistory({
  stored = {},
  rules = null,
  now = Date.now,
  cap = COPY_CAP_PER_TARGET,
  subtle,
} = {}) {
  const initial = pruneCopyHistory(stored, rules, cap);
  const history = initial.history;
  let version = initial.changed ? 1 : 0;
  let savedVersion = 0;
  let pendingAdds = 0;
  const dirtyBuckets = new Set();
  // Memoize hashed keys per MessageHeader object within one run.
  const keyCache = new WeakMap();

  if (initial.changed) {
    for (const [ruleId, byDest] of Object.entries(history)) {
      for (const destId of Object.keys(byDest)) dirtyBuckets.add(copyBucketKey(ruleId, destId));
    }
  }

  async function keyFor(header) {
    if (!header || typeof header !== 'object') return null;
    if (keyCache.has(header)) return keyCache.get(header);
    const key = await copyKeyOf(header, subtle);
    keyCache.set(header, key);
    return key;
  }

  return {
    get version() {
      return version;
    },

    get pendingAdds() {
      return pendingAdds;
    },

    isDirty() {
      return version !== savedVersion;
    },

    /**
     * Separate `ids` into those not yet copied to `(ruleId, destFolderId)` and
     * those already copied (including duplicate copies of the same message
     * inside `ids` itself).
     */
    async filterUncopied(ruleId, destFolderId, ids, headersById) {
      const bucket = history[ruleId]?.[destFolderId] ?? {};
      const seen = new Set();
      const toCopy = [];
      const skipped = [];
      const keysById = new Map();

      for (const id of ids) {
        const key = await keyFor(headersById?.get?.(id));
        if (key === null) {
          toCopy.push(id);
          continue;
        }
        if (Object.hasOwn(bucket, key) || seen.has(key)) {
          skipped.push(id);
          continue;
        }
        seen.add(key);
        keysById.set(id, key);
        toCopy.push(id);
      }

      return { toCopy, skipped, keysById };
    },

    /**
     * Record a completed copy batch. Called right after each batch succeeds so
     * a later failure or event-page suspension cannot lose what already copied.
     */
    recordCopied(ruleId, destFolderId, ids, keysById) {
      if (!ruleId || !destFolderId || !ids?.length) return false;
      let added = false;
      const stampedAt = now();
      for (const id of ids) {
        const key = keysById?.get?.(id);
        if (!key) continue;
        history[ruleId] ??= {};
        history[ruleId][destFolderId] ??= {};
        history[ruleId][destFolderId][key] = stampedAt;
        added = true;
      }
      if (!added) return false;
      const trimmed = trimBucket(history[ruleId][destFolderId], cap);
      history[ruleId][destFolderId] = trimmed.bucket;
      dirtyBuckets.add(copyBucketKey(ruleId, destFolderId));
      pendingAdds += ids.length;
      version += 1;
      return true;
    },

    /** Plain copy ready to persist to `storage.local`. */
    snapshot() {
      return pruneCopyHistory(history, rules, cap).history;
    },

    /**
     * Sharded `{ toSet, toRemove }` diff against `knownShardKeys`, so saving a
     * copy batch writes only the single bucket that changed instead of
     * rewriting every rule's history.
     */
    shardedPatch(knownShardKeys = [], { forceAll = false } = {}) {
      const pruned = pruneCopyHistory(history, rules, cap).history;
      const liveKeys = new Set();
      const toSet = {};
      for (const [ruleId, byDest] of Object.entries(pruned)) {
        for (const [destId, bucket] of Object.entries(byDest)) {
          const key = copyBucketKey(ruleId, destId);
          liveKeys.add(key);
          if (forceAll || dirtyBuckets.has(key)) toSet[key] = bucket;
        }
      }
      const toRemove = knownShardKeys.filter((k) => !liveKeys.has(k));
      return { toSet, toRemove, liveKeys: [...liveKeys] };
    },

    /** Record that `savedAtVersion` was persisted successfully. */
    markSaved(savedAtVersion) {
      if (savedAtVersion > savedVersion) savedVersion = savedAtVersion;
      if (savedVersion === version) {
        dirtyBuckets.clear();
        pendingAdds = 0;
      }
    },

    /** History to save at the end of a run, or null when nothing changed. */
    finish() {
      return version !== savedVersion ? pruneCopyHistory(history, rules, cap).history : null;
    },
  };
}
