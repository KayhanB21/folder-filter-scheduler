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
 * message's character set. A plain-text part is used as it is. An HTML part is
 * used only when the message has no plain-text part, and `toPlainText` turns
 * it into text first, so a body condition never matches tag names or styles.
 *
 * Reading a body costs a download on an IMAP folder that isn't stored for
 * offline use, so the runner reads it only for a message that the rule's
 * other conditions leave undecided. See decideWithoutBody in matcher.js.
 *
 * A read that passes `timeoutMs` leaves the message out of the run. When
 * `limit` reads have done that, the reader stops reading for the rest of the
 * run, for the same reason as headers.js: Thunderbird suspends an idle event
 * page after about 30 seconds.
 *
 * @param {object} options
 * @param {(id: number) => Promise<{contentType: string, content: string}[]>} options.listInlineTextParts
 * @param {(html: string) => Promise<string>} options.toPlainText
 * @param {number} options.timeoutMs limit for one read
 * @param {number} options.limit reads without an answer before reading stops
 * @param {(message: string) => unknown} [options.onTimeout] told about each
 *   wait, and awaited, so the caller can save its log at once
 */
export function createBodyReads({ listInlineTextParts, toPlainText, timeoutMs, limit, onTimeout = () => {} }) {
  const seconds = timeoutMs / 1000;

  const reads = {
    /** Reads that ended with no answer. */
    timeouts: 0,
    /** Messages left out of the run because their body did not arrive. */
    skipped: 0,
    get stopped() {
      return reads.timeouts >= limit;
    },

    /**
     * The body of one message as plain text, or null when the message must be
     * left out of the run. An error other than a timeout is thrown.
     *
     * @param {number} messageId
     */
    async read(messageId) {
      if (reads.stopped) {
        reads.skipped += 1;
        return null;
      }
      try {
        return await withTimeout(bodyText(messageId, listInlineTextParts, toPlainText), timeoutMs);
      } catch (e) {
        if (e?.name !== 'TimeoutError') throw e;
        reads.timeouts += 1;
        reads.skipped += 1;
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

/** The plain-text parts joined, or the HTML parts as text when there are none. */
async function bodyText(messageId, listInlineTextParts, toPlainText) {
  const parts = (await listInlineTextParts(messageId)) ?? [];
  const plain = parts.filter((p) => isType(p, 'text/plain'));
  if (plain.length > 0) return plain.map((p) => p.content ?? '').join('\n');

  const html = parts.filter((p) => isType(p, 'text/html'));
  const texts = [];
  for (const part of html) texts.push(await toPlainText(part.content ?? ''));
  return texts.join('\n');
}
