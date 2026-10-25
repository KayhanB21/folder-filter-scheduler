/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { withTimeout } from '../runner.js';
import { OWN_ON, UNKNOWN, checkMessage, combine } from './check.js';
import {
  QUICK_DELAYS_MS,
  cacheKeyOf,
  isPending,
  needsCheck,
  pruneCache,
  quickRetryDelay,
  recordCheck,
  settingsKeyOf,
} from './cache.js';

/**
 * The SPF, DKIM, and DMARC reads of one run.
 *
 * Pure and free of extension APIs, like headers.js: the download and the DNS
 * query are passed in, and the caller loads and saves the cache.
 *
 * For each message, the cache decides whether to download it (see cache.js).
 * A download that passes `timeoutMs`, or any error from it, is a temporary
 * failure, the same as a DNS error.
 *
 * The run spends at most `budgetMs` on downloads. Thunderbird suspends an
 * idle event page after about 30 seconds, and the run still has to act, log,
 * and save. A message left over is pending: its conditions don't match this
 * time, and a run 20 seconds later continues. It doesn't count as a failed
 * attempt. Because a pending message holds the scan watermark, each run until
 * then is a catch-up scan, which reaches mail from the last 30 days.
 *
 * `pending` on a read tells the caller to keep the scan watermark, so the
 * next incremental run sees the message again.
 *
 * @param {object} options
 * @param {(id: number) => Promise<string>} options.getRaw
 * @param {Function|null} options.queryFunction a DoH query function, or null
 * @param {string} options.ownState OWN_ON, OWN_OFF, or OWN_BLOCKED
 * @param {string} options.prefer PREFER_OWN or PREFER_PROVIDER
 * @param {string[]} options.trustedServers
 * @param {object} options.cache the stored cache; never mutated
 * @param {number} options.timeoutMs limit for one download
 * @param {number} options.budgetMs limit for all downloads of the run
 * @param {() => number} [options.now]
 * @param {SubtleCrypto} [options.subtle]
 */
export function createAuthReads({
  getRaw,
  queryFunction,
  ownState,
  prefer,
  trustedServers,
  cache: stored = {},
  timeoutMs,
  budgetMs,
  now = Date.now,
  subtle,
}) {
  const cache = { ...stored };
  const settingsKey = settingsKeyOf({ ownState, trustedServers });
  const startedAt = now();
  let dirty = false;
  let retryDelay = null;
  const retryAfter = (delay) => {
    retryDelay = retryDelay === null ? delay : Math.min(retryDelay, delay);
  };

  const counts = {
    /** Messages downloaded and checked. */
    checked: 0,
    /** Messages answered from the cache. */
    cached: 0,
    /** Checks that hit a temporary error. */
    failed: 0,
    /** Messages left for a later run when the time budget ran out. */
    deferred: 0,
    /** Messages whose retries ran out, so their results stay unknown. */
    unchecked: 0,
    /** Checks where the own result and the provider's header differ. */
    disagree: 0,
  };

  const unknown = { spf: UNKNOWN, dkim: UNKNOWN, dmarc: UNKNOWN };

  // Spam often comes from a few domains, so one run asks for the same key or
  // DMARC record many times. Each distinct query goes out once per run.
  const answers = new Map();
  const memoQuery = queryFunction && ((query) => {
    const id = String.fromCharCode(...query);
    if (!answers.has(id)) answers.set(id, queryFunction(query));
    return answers.get(id);
  });

  async function check(header) {
    try {
      const raw = await withTimeout(Promise.resolve(getRaw(header.id)), timeoutMs);
      return await checkMessage(raw, {
        own: ownState,
        queryFunction: ownState === OWN_ON ? memoQuery : null,
        trustedServers,
      });
    } catch {
      return { provider: null, own: null, retry: true };
    }
  }

  return {
    counts,
    ownState,

    /**
     * The results for one message, as `{ auth, pending }`. `auth` holds
     * `pass`, `notPass`, or `unknown` for each of spf, dkim, and dmarc.
     */
    async read(header) {
      const key = await cacheKeyOf(header, subtle);
      let entry = key ? cache[key] : undefined;
      const time = now();
      let fresh = false;

      if (needsCheck(entry, { settingsKey, now: time })) {
        if (time - startedAt >= budgetMs) {
          counts.deferred += 1;
          retryAfter(QUICK_DELAYS_MS[0]);
          return { auth: { ...unknown }, pending: true };
        }
        const result = await check(header);
        entry = recordCheck(entry, result, { settingsKey, now: time });
        fresh = true;
        counts.checked += 1;
        if (key) {
          cache[key] = entry;
          dirty = true;
        }
        if (entry.retry) {
          counts.failed += 1;
          const delay = quickRetryDelay(entry);
          if (delay !== null) retryAfter(delay);
        }
      } else {
        counts.cached += 1;
      }

      // Without a cache key a failure can't be tracked from run to run, so
      // the message is not held for a retry.
      const pending = key !== null && isPending(entry, time);
      if (entry.retry && !pending) counts.unchecked += 1;

      const { disagree, ...auth } = combine(entry, { prefer, ownState });
      if (fresh) counts.disagree += disagree;
      return { auth, pending };
    },

    /**
     * What the caller does after the run: the cache to save, or null when
     * nothing changed, and the delay before the next quick retry, or null.
     */
    finish() {
      return {
        cache: dirty ? pruneCache(cache, now()) : null,
        retryDelayMs: retryDelay,
      };
    },
  };
}
