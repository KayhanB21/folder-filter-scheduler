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
 * A wait that ends with no headers counts toward `limit`. When that many have
 * piled up, the reader stops reading, because Thunderbird suspends an idle
 * event page after about 30 seconds and the run still has to log and save. A
 * `getHeaders` wait that `getFull` then makes good is not counted: the run is
 * moving again.
 *
 * @param {object} options
 * @param {(id: number) => Promise<object>} [options.getHeaders] absent on a
 *   Thunderbird without the call; every read then uses `getFull`
 * @param {(id: number) => Promise<object>} options.getFull
 * @param {number} options.timeoutMs limit for one call
 * @param {number} options.limit waits without headers before reading stops
 * @param {(message: string) => unknown} [options.onTimeout] told about each
 *   wait, and awaited, so the caller can save its log at once
 */
export function createHeaderReads({ getHeaders, getFull, timeoutMs, limit, onTimeout = () => {} }) {
  const viaFull = new Set();
  const seconds = timeoutMs / 1000;
  const headersOf = (raw) => raw?.headers ?? raw ?? {};
  const isTimeout = (e) => e?.name === 'TimeoutError';

  const reads = {
    /** Waits that ended with no headers. */
    timeouts: 0,
    /** Messages left out of the run because their headers did not arrive. */
    skipped: 0,
    get stopped() {
      return reads.timeouts >= limit;
    },

    /**
     * The headers of one message, or null when the message must be left out
     * of the run. An error other than a timeout is thrown to the caller.
     *
     * @param {number} messageId
     * @param {string} [accountId] the fallback is remembered for each account
     */
    async read(messageId, accountId = '') {
      if (reads.stopped) {
        reads.skipped += 1;
        return null;
      }

      let waited = false;
      if (getHeaders && !viaFull.has(accountId)) {
        try {
          return headersOf(await withTimeout(getHeaders(messageId), timeoutMs));
        } catch (e) {
          if (!isTimeout(e)) throw e;
          waited = true;
          reads.timeouts += 1;
          viaFull.add(accountId);
          await onTimeout(
            `header read gave no answer after ${seconds} s, reading whole messages on this account instead`,
          );
          if (reads.stopped) {
            reads.skipped += 1;
            return null;
          }
        }
      }

      try {
        const headers = headersOf(await withTimeout(getFull(messageId), timeoutMs));
        if (waited) reads.timeouts -= 1;
        return headers;
      } catch (e) {
        if (!isTimeout(e)) throw e;
        reads.timeouts += 1;
        reads.skipped += 1;
        await onTimeout(
          `whole-message read gave no answer after ${seconds} s` +
            (reads.stopped ? `; ${limit} reads gave no answer, no more header reads this run` : ''),
        );
        return null;
      }
    },
  };
  return reads;
}
