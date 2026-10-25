/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The cache of SPF, DKIM, and DMARC results, kept in `storage.local`.
 *
 * Pure, like diagnostics.js: it takes and returns plain objects, and
 * background.js does the reading and writing.
 *
 * Why a cache. The check downloads the whole message, and a DKIM key can
 * disappear after the sender rotates it, so a later check of old mail fails.
 * Each message is checked once, soon after it arrives, and the result kept.
 *
 * The key. Thunderbird's message id changes when a message moves, so the key
 * is a hash of values from the message index instead: Message-ID, author,
 * date, and size. A lookup then costs no download. For a cache hit on forged
 * mail, a sender would have to match all four values of a message you
 * already received.
 *
 * Retries. A DNS error or a download that timed out is a temporary failure.
 * The add-on tries again 20 seconds later, then 40 seconds after that. After
 * those 3 attempts it tries once every 30 minutes, the catch-up interval,
 * until 24 hours after the first failure. Then it stops and keeps the result
 * as unknown. Until a check succeeds, the conditions on that message never
 * match.
 */

export const AUTH_CACHE_KEY = 'authCache';
export const CACHE_CAP = 5000;
export const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const QUICK_ATTEMPTS = 3;
/** The wait after attempt 1, then after attempt 2. */
export const QUICK_DELAYS_MS = Object.freeze([20_000, 40_000]);
export const SLOW_RETRY_MS = 30 * 60 * 1000;
export const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * The cache key of a message, from its indexed MessageHeader. Null when the
 * message has no Message-ID: without one, two messages could share a key.
 */
export async function cacheKeyOf(header, subtle = globalThis.crypto.subtle) {
  const id = String(header?.headerMessageId ?? '').trim();
  if (!id) return null;
  const date = header.date instanceof Date ? header.date.toISOString() : String(header.date ?? '');
  const text = [id, header.author ?? '', date, header.size ?? ''].join('\n');
  return toHex(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/**
 * The settings that change what a check finds. An entry made under other
 * settings is a miss, so changing them takes effect without clearing the
 * cache. `prefer` isn't here: the entry keeps both sources and the choice is
 * made when the condition reads them.
 */
export function settingsKeyOf({ ownState, trustedServers = [] }) {
  return `own=${ownState};trusted=${[...trustedServers].sort().join(',')}`;
}

/** True while an entry still waits for a retry to succeed. */
export function isPending(entry, now) {
  return entry?.retry === true && now < entry.retryUntil;
}

/** True when the message must be downloaded and checked now. */
export function needsCheck(entry, { settingsKey, now }) {
  if (!entry || entry.settingsKey !== settingsKey) return true;
  if (now - entry.checkedAt > CACHE_TTL_MS) return true;
  if (!isPending(entry, now)) return false;
  if (entry.attempts < QUICK_ATTEMPTS) return true;
  return now - entry.checkedAt >= SLOW_RETRY_MS;
}

/**
 * The entry after a check. `result` is what check.js returned, or
 * `{ provider: null, own: null, retry: true }` for a download that timed out.
 */
export function recordCheck(previous, result, { settingsKey, now }) {
  const entry = { provider: result.provider, own: result.own, settingsKey, checkedAt: now };
  if (!result.retry) return { ...entry, retry: false };

  // A failure carries on the count only from a failure under the same settings.
  const carried = previous?.retry === true && previous.settingsKey === settingsKey;
  const firstFailAt = carried ? previous.firstFailAt : now;
  return {
    ...entry,
    // A temporary failure keeps any definite result an earlier attempt found.
    provider: result.provider ?? (carried ? previous.provider : null),
    retry: true,
    attempts: (carried ? previous.attempts : 0) + 1,
    firstFailAt,
    retryUntil: firstFailAt + RETRY_WINDOW_MS,
  };
}

/** How long to wait before the next quick retry, or null when none is due. */
export function quickRetryDelay(entry) {
  if (entry?.retry !== true || entry.attempts >= QUICK_ATTEMPTS) return null;
  return QUICK_DELAYS_MS[entry.attempts - 1] ?? null;
}

/**
 * Drop expired entries, then the oldest beyond the cap. Never mutates.
 */
export function pruneCache(cache, now, cap = CACHE_CAP) {
  const live = Object.entries(cache ?? {}).filter(([, e]) => e && now - e.checkedAt <= CACHE_TTL_MS);
  live.sort(([, a], [, b]) => b.checkedAt - a.checkedAt);
  return Object.fromEntries(live.slice(0, cap));
}
