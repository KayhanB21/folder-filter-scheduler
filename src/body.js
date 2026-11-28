/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { withTimeout } from './runner.js';

/**
 * Body reads for one run, for the body condition (#38).
 *
 * Pure and free of extension APIs, like headers.js: the two Thunderbird calls
 * are passed in, so the policy is unit-testable.
 *
 * `listInlineTextParts` returns the text parts of a message that Thunderbird
 * shows inline, already decoded from quoted-printable, base64, and the
 * message's character set. A plain-text part is used as it is. `toPlainText`
 * turns an HTML part into text first, so a body condition never matches tag
 * names or styles. Both kinds are read, as Thunderbird's own body search does:
 * spam often puts other text, or none, in the plain-text part (#38).
 *
 * Reading a body costs a download on an IMAP folder that isn't stored for
 * offline use, so the runner reads it only for a message that the rule's
 * other conditions leave undecided. See decideWithoutBody in matcher.js.
 *
 * A read that passes `timeoutMs` leaves the message out of the run. When
 * `limit` reads have done that, or when `budgetMs` has elapsed across the run,
 * the reader stops issuing fresh downloads for the rest of the run, for the
 * same reason as headers.js: Thunderbird suspends an idle event page after
 * about 30 seconds.
 *
 * Successful reads are cached for the lifetime of the reader so multiple rules
 * watching the same folder do not re-download the same message body in one run.
 *
 * @param {object} options
 * @param {(id: number) => Promise<{contentType: string, content: string}[]>} options.listInlineTextParts
 * @param {(html: string) => Promise<string>} options.toPlainText
 * @param {number} options.timeoutMs limit for one read
 * @param {number} options.limit reads without an answer before reading stops
 * @param {number} [options.budgetMs] total wall-clock budget for fresh reads
 *   across the run (defaults to Infinity)
 * @param {() => number} [options.now] clock for `budgetMs`, injectable for tests
 * @param {(message: string) => unknown} [options.onTimeout] told about each
 *   wait, and awaited, so the caller can save its log at once
 */
export function createBodyReads({
  listInlineTextParts,
  toPlainText,
  timeoutMs,
  limit,
  budgetMs = Infinity,
  now = Date.now,
  onTimeout = () => {},
}) {
  const cache = new Map();
  const failed = new Set();
  const startedAt = now();
  let budgetExceeded = false;
  const seconds = timeoutMs / 1000;

  const reads = {
    /** Reads that ended with no answer. */
    timeouts: 0,
    /** Messages left out of the run because their body did not arrive. */
    skipped: 0,
    /** Requests satisfied from this run's in-memory cache. */
    cached: 0,
    get stopped() {
      return reads.timeouts >= limit || budgetExceeded;
    },

    /** Remember a message whose body read threw so later rules in the same run skip it at once. */
    markFailed(messageId) {
      failed.add(messageId);
    },

    /**
     * The text parts of one message as plain text, one string per part, or
     * null when the message must be left out of the run. An error other than a timeout is thrown.
     *
     * @param {number} messageId
     */
    async read(messageId) {
      if (cache.has(messageId)) {
        reads.cached += 1;
        return cache.get(messageId);
      }
      if (failed.has(messageId) || reads.stopped) {
        reads.skipped += 1;
        return null;
      }
      if (now() - startedAt >= budgetMs) {
        budgetExceeded = true;
        reads.skipped += 1;
        await onTimeout(
          `body reads reached the ${budgetMs / 1000} s time budget, remaining messages will be checked on the next run`,
        );
        return null;
      }
      try {
        const texts = await withTimeout(bodyText(messageId, listInlineTextParts, toPlainText), timeoutMs);
        cache.set(messageId, texts);
        return texts;
      } catch (e) {
        if (e?.name !== 'TimeoutError') throw e;
        reads.timeouts += 1;
        reads.skipped += 1;
        failed.add(messageId);
        await onTimeout(
          `body read gave no answer after ${seconds} s` +
            (reads.stopped ? `; ${limit} reads gave no answer, no more body reads this run` : ''),
        );
        return null;
      }
    },
  };
  return reads;
}

const isType = (part, type) => String(part?.contentType ?? '').toLowerCase().startsWith(type);

/** Every plain-text and HTML part as text, in message order. */
async function bodyText(messageId, listInlineTextParts, toPlainText) {
  const parts = (await listInlineTextParts(messageId)) ?? [];
  const texts = [];
  for (const part of parts) {
    if (isType(part, 'text/plain')) texts.push(part.content ?? '');
    else if (isType(part, 'text/html')) texts.push(await toPlainText(part.content ?? ''));
  }
  return texts;
}
