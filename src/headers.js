/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { withTimeout } from './runner.js';

/**
 * Header reads for one run, with a time limit and a second way to read.
 *
 * Pure and free of extension APIs, like matcher.js and scan.js: the two
 * Thunderbird calls are passed in, so the whole policy is unit-testable.
 *
 * Thunderbird has two calls that return a message's headers. `getHeaders`
 * skips MIME parsing and is the fast one. `getFull` reads the whole message.
 * On some accounts `getHeaders` never answers while `getFull` does (#15). So a
 * `getHeaders` call that passes the limit is abandoned, the same message is
 * read with `getFull`, and the account stays on `getFull` for the rest of the
 * run. Accounts where `getHeaders` answers keep it.
 *
 * The caller can carry the switched accounts from one run to the next: it
 * passes the ones it knows in `viaFull` and hears about a new one through
 * `onSwitch`. Each later run then skips the wait on those accounts.
 *
 * A wait that ends with no headers counts toward `limit`. When that many have
 * piled up, or when `budgetMs` has elapsed across the run, the reader stops
 * issuing fresh downloads, because Thunderbird suspends an idle event page
 * after about 30 seconds and the run still has to log and save. A `getHeaders`
 * wait that `getFull` then makes good is not counted: the run is moving again.
 *
 * Reads are memoised for the lifetime of the reader, so multiple rules
 * watching the same folder never fetch the same message's headers twice in one
 * run (and cache hits still succeed even after the time budget is reached).
 *
 * @param {object} options
 * @param {(id: number) => Promise<object>} [options.getHeaders] absent on a
 *   Thunderbird without the call; every read then uses `getFull`
 * @param {(id: number) => Promise<object>} options.getFull
 * @param {number} options.timeoutMs limit for one call
 * @param {number} options.limit waits without headers before reading stops
 * @param {number} [options.budgetMs] total wall-clock budget for fresh reads
 *   across the run (defaults to Infinity)
 * @param {() => number} [options.now] clock for `budgetMs`, injectable for tests
 * @param {(message: string) => unknown} [options.onTimeout] told about each
 *   wait, and awaited, so the caller can save its log at once
 * @param {Iterable<string>} [options.viaFull] accounts already known to need
 *   `getFull`
 * @param {(accountId: string) => unknown} [options.onSwitch] told, and
 *   awaited, when an account with an id moves to `getFull`
 */
export function createHeaderReads({
  getHeaders,
  getFull,
  timeoutMs,
  limit,
  budgetMs = Infinity,
  now = Date.now,
  onTimeout = () => {},
  viaFull: known = [],
  onSwitch = () => {},
}) {
  const viaFull = new Set(known);
  const cache = new Map();
  const failed = new Set();
  let spentMs = 0;
  let slowestMs = 0;
  let budgetExceeded = false;
  /** Add the time of one call to the run total. Returns the time of the call. */
  const spend = (start) => {
    const ms = Math.max(0, now() - start);
    spentMs += ms;
    return ms;
  };
  /** Count a call that returned an answer. */
  const answered = (ms) => {
    reads.fresh += 1;
    slowestMs = Math.max(slowestMs, ms);
  };
  const seconds = timeoutMs / 1000;
  // `getFull` returns a message part whose `headers` property is the
  // dictionary. `getHeaders` returns the dictionary itself, so a property
  // named `headers` there is a header line named "Headers" that the sender
  // wrote, and reading it as the dictionary would drop every real header.
  const headersOfPart = (raw) => raw?.headers ?? raw ?? {};
  const isTimeout = (e) => e?.name === 'TimeoutError';
  // An account id is a key such as "account3", so the log can name it.
  const onAccount = (accountId) => (accountId ? ` on account ${accountId}` : '');

  const remainingBudget = () => Math.max(0, budgetMs - spentMs);

  const hitBudget = async () => {
    const first = !budgetExceeded;
    budgetExceeded = true;
    reads.skipped += 1;
    if (first) {
      await onTimeout(
        `header reads reached the ${budgetMs / 1000} s time budget, remaining messages will be checked on the next run`,
      );
    }
    return null;
  };

  const reads = {
    /** Waits that ended with no headers. */
    timeouts: 0,
    /** Messages left out of the run because their headers did not arrive. */
    skipped: 0,
    /** Requests satisfied from this run's in-memory cache. */
    cached: 0,
    /** Calls to Thunderbird that returned an answer. */
    fresh: 0,
    /** The longest of those calls, in milliseconds. */
    get slowestMs() {
      return slowestMs;
    },
    /** Total milliseconds spent inside fresh Thunderbird header calls this run. */
    get spentMs() {
      return spentMs;
    },
    /** True when fresh reads stopped because `budgetMs` was exhausted. */
    get budgetReached() {
      return budgetExceeded;
    },
    get stopped() {
      return reads.timeouts >= limit || budgetExceeded;
    },

    /** Remember a message whose read threw so later rules in the same run skip it at once. */
    markFailed(messageId) {
      failed.add(messageId);
    },

    /**
     * The headers of one message, or null when the message must be left out
     * of the run. An error other than a timeout is thrown to the caller.
     *
     * @param {number} messageId
     * @param {string} [accountId] the fallback is remembered for each account
     */
    async read(messageId, accountId = '') {
      if (cache.has(messageId)) {
        reads.cached += 1;
        return cache.get(messageId);
      }
      if (failed.has(messageId) || reads.stopped) {
        reads.skipped += 1;
        return null;
      }
      if (remainingBudget() <= 0) {
        return hitBudget();
      }

      let waited = false;
      if (getHeaders && !viaFull.has(accountId)) {
        const callLimit = Math.min(timeoutMs, remainingBudget());
        const callStart = now();
        try {
          const headers = (await withTimeout(getHeaders(messageId), callLimit)) ?? {};
          answered(spend(callStart));
          cache.set(messageId, headers);
          return headers;
        } catch (e) {
          spend(callStart);
          if (!isTimeout(e)) throw e;
          // If the timeout fired solely because the remaining run budget ran out,
          // stop cleanly without blaming `getHeaders` or switching the account.
          if (callLimit < timeoutMs || remainingBudget() <= 0) {
            return hitBudget();
          }
          waited = true;
          reads.timeouts += 1;
          viaFull.add(accountId);
          // A message with no account id is not remembered: the empty id would
          // stand for every such message in later runs.
          if (accountId) await onSwitch(accountId);
          await onTimeout(
            `header read gave no answer after ${seconds} s${onAccount(accountId)}, reading whole messages on this account instead`,
          );
          if (reads.stopped) {
            failed.add(messageId);
            reads.skipped += 1;
            return null;
          }
        }
      }

      if (remainingBudget() <= 0) {
        return hitBudget();
      }

      const fullLimit = Math.min(timeoutMs, remainingBudget());
      const fullStart = now();
      try {
        const headers = headersOfPart(await withTimeout(getFull(messageId), fullLimit));
        answered(spend(fullStart));
        if (waited) reads.timeouts -= 1;
        cache.set(messageId, headers);
        return headers;
      } catch (e) {
        spend(fullStart);
        if (!isTimeout(e)) throw e;
        if (fullLimit < timeoutMs || remainingBudget() <= 0) {
          return hitBudget();
        }
        reads.timeouts += 1;
        reads.skipped += 1;
        failed.add(messageId);
        await onTimeout(
          `whole-message read gave no answer after ${seconds} s${onAccount(accountId)}` +
            (reads.stopped ? `; ${limit} reads gave no answer, no more header reads this run` : ''),
        );
        return null;
      }
    },
  };
  return reads;
}

/**
 * Read a message's headers, or return null when the read fails for any reason.
 *
 * `headerReads.read()` already turns timeouts into null and counts them in
 * `skipped`. Other errors (such as a transient IMAP failure) are thrown to the
 * caller so they can be logged; this helper counts those in `skipped` too and
 * returns null, so the message is never evaluated on empty headers and the
 * scan watermark holds for a retry.
 *
 * @param {{ read: Function, skipped: number, markFailed?: Function }} headerReads
 * @param {number} messageId
 * @param {string} [accountId]
 * @param {(error: unknown) => unknown} [onError]
 */
export async function readHeadersOrSkip(headerReads, messageId, accountId, onError = () => {}) {
  try {
    return await headerReads.read(messageId, accountId);
  } catch (e) {
    headerReads.skipped += 1;
    headerReads.markFailed?.(messageId);
    await onError(e);
    return null;
  }
}
