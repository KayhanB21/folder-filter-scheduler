/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Stop running later rules" for a message the stopping rule did not scan.
 *
 * Pure and free of extension APIs, like matcher.js and scan.js: the caller
 * passes in the function that evaluates one rule against one message.
 *
 * A stopping rule marks the messages it matches during its own scan, and later
 * rules in the same run skip them. That mark covers only the stopping rule's
 * scan window. A scheduled scan reads recent mail, and a rule with an age
 * condition reads the whole folder, so a later rule can match a message that
 * the stopping rule did not read in this run. The stopping rule might also be
 * absent from the run: a rule on its own schedule, or the Run button on one
 * rule, runs without it.
 *
 * So before a rule acts on a message, the guard evaluates every enabled
 * stopping rule that is ordered before it and watches the same folder. The
 * check runs only for a message the later rule matched, so a run without
 * stopping rules pays nothing.
 */

export const GUARD_VERDICTS = Object.freeze({
  /** No earlier stopping rule matches: the rule can act. */
  clear: 'clear',
  /** An earlier stopping rule matches: the rule must leave the message alone. */
  stopped: 'stopped',
  /**
   * A read that an earlier stopping rule needs did not arrive. The rule must
   * leave the message alone in this run and check it again in the next one.
   */
  unknown: 'unknown',
});

/**
 * @param {object} options
 * @param {object[]} options.rules every saved rule, in run order
 * @param {(rule: object) => Iterable<string>} options.foldersOf the folders a
 *   rule scans, subfolders included
 * @param {(stopRule: object, header: object) => Promise<boolean|null>|boolean|null} options.evaluate
 *   true when the stopping rule matches the message, false when it doesn't,
 *   and null when a read it needs did not arrive
 * @param {(stopRule: object, error: unknown) => unknown} [options.onError]
 *   told when `evaluate` throws; the verdict is then `unknown`
 */
export function createStopGuard({ rules, foldersOf, evaluate, onError = () => {} }) {
  const ordered = Array.isArray(rules) ? rules : [];
  const position = new Map(ordered.map((rule, index) => [rule, index]));
  const stopping = ordered.filter((r) => r?.enabled !== false && r?.stopProcessing === true);
  const folderSets = new Map();
  const foldersFor = (rule) => {
    if (!folderSets.has(rule)) folderSets.set(rule, new Set(foldersOf(rule) ?? []));
    return folderSets.get(rule);
  };

  // A rule that is not in the saved list has no place in the order, so no
  // saved rule counts as earlier.
  const earlier = (rule) => {
    const at = position.get(rule);
    return at === undefined ? [] : stopping.filter((s) => position.get(s) < at);
  };

  const guard = {
    /** The earlier stopping rules that watch one folder. */
    guardsFor(rule, folderId) {
      return earlier(rule).filter((s) => foldersFor(s).has(folderId));
    },

    /** The earlier stopping rules that watch at least one of the folders. */
    guardsAcross(rule, folderIds) {
      const ids = [...(folderIds ?? [])];
      return earlier(rule).filter((s) => ids.some((id) => foldersFor(s).has(id)));
    },

    /**
     * Decide whether `rule` can act on one message it matched in `folderId`.
     * A definite match by any stopping rule wins over an unread one.
     *
     * @returns {Promise<string>} one of GUARD_VERDICTS
     */
    async check(rule, folderId, header) {
      let unknown = false;
      for (const stopRule of guard.guardsFor(rule, folderId)) {
        let verdict;
        try {
          verdict = await evaluate(stopRule, header);
        } catch (e) {
          await onError(stopRule, e);
          verdict = null;
        }
        if (verdict === true) return GUARD_VERDICTS.stopped;
        if (verdict !== false) unknown = true;
      }
      return unknown ? GUARD_VERDICTS.unknown : GUARD_VERDICTS.clear;
    },
  };
  return guard;
}
