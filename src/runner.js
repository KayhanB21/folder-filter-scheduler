/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The re-entrancy gate around a run.
 *
 * Pure and free of extension APIs, like matcher.js and scan.js: it is handed a
 * function that performs a run and decides when that function may be called.
 *
 * Why this exists. A run reads the per-rule run state, scans, acts, and writes
 * the state back. With the alarm as the only trigger that read-modify-write was
 * safe by construction. Adding `messages.onNewMailReceived` means a triggered
 * run can start while the scheduled one is still going: both would read the
 * same `lastRunAt`, and whichever finished last would overwrite the other, so a
 * window of mail is rescanned or, worse, skipped. The same messages could also
 * be actioned twice.
 *
 * The gate serialises runs and collapses redundant ones. While a run is in
 * flight, further triggers do not queue up one behind another: at most one
 * follow-up run is pending, because a second incremental pass covers everything
 * a third would have. A burst of fifty arrivals therefore costs one run, or two
 * if it lands mid-run.
 *
 * A manual request is the exception that cannot be collapsed into a scheduled
 * one. "Run all rules now" means a full scan of every folder, and answering it
 * with an incremental pass that happened to be running would silently do less
 * than the user asked. So a manual request upgrades whatever is queued, and its
 * caller waits for the run that actually honours it.
 *
 * A manual request can also name the rules it wants (`ruleIds`), which is the
 * Run button on one rule. Only those rules get the full scan. If a scheduled or
 * new-mail trigger shares the queued run, `background` is true and the other
 * rules get the incremental pass that trigger asked for, scoped by `folderIds`
 * as usual. A full scan is never widened to rules nobody asked to run in full.
 */

/**
 * `run` receives `{ folderIds, ruleIds, background }`. A null `folderIds` or
 * `ruleIds` means "all of them".
 *
 * @param {(reason: string, context: object) => Promise<number>} run
 * @returns {{request: (reason: string, context?: object) => Promise<number>, isRunning: () => boolean}}
 */
export function createRunner(run) {
  let inFlight = null;
  // { reason, folderIds: Set|null, ruleIds: Set|null, background, promise, resolve, reject }
  let queued = null;

  const isManual = (reason) => reason === 'manual';

  /**
   * Merge a new trigger into the pending one. A null folder set means "every
   * folder": once one trigger asks for an unscoped run, narrowing it again
   * would drop rules the earlier trigger wanted covered.
   */
  function mergeScope(existing, incoming) {
    if (existing === null || incoming === null) return null;
    return new Set([...existing, ...incoming]);
  }

  /** The scope one trigger asks for on its own. */
  function scopeOf(reason, folderIds, ruleIds) {
    return isManual(reason)
      ? { folderIds: null, ruleIds, background: false }
      : { folderIds, ruleIds: null, background: true };
  }

  function start(reason, scope) {
    // Called synchronously, so `isRunning()` is true before this returns: the
    // alarm and a new-mail timer can fire in the same tick, and the second must
    // see the first.
    let started;
    try {
      started = Promise.resolve(run(reason, scope));
    } catch (e) {
      started = Promise.reject(e);
    }

    inFlight = started.finally(() => {
      inFlight = null;
      const next = queued;
      queued = null;
      if (next) {
        const { reason: nextReason, folderIds, ruleIds, background } = next;
        start(nextReason, { folderIds, ruleIds, background }).then(next.resolve, next.reject);
      }
    });
    return inFlight;
  }

  function request(reason, { folderIds = null, ruleIds = null } = {}) {
    const scope = scopeOf(reason, folderIds, ruleIds);
    if (!inFlight) return start(reason, scope);

    if (!queued) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      queued = { reason, ...scope, promise, resolve, reject };
      return promise;
    }

    // Already something pending: widen it rather than adding another run.
    if (!isManual(reason)) {
      queued.folderIds = queued.background ? mergeScope(queued.folderIds, folderIds) : folderIds;
      queued.background = true;
    } else if (isManual(queued.reason)) {
      queued.ruleIds = mergeScope(queued.ruleIds, ruleIds);
    } else {
      queued.reason = reason;
      queued.ruleIds = ruleIds;
    }
    // A manual run of every rule covers any background pass, and is never
    // folder-scoped.
    if (isManual(queued.reason) && queued.ruleIds === null) queued.folderIds = null;
    return queued.promise;
  }

  return { request, isRunning: () => inFlight !== null };
}

/**
 * Reject when `promise` has not settled within `ms`.
 *
 * A Thunderbird API call that never answers would otherwise hold a run open
 * until the event page is suspended, with nothing in the log to show where it
 * stopped. The original call is not cancelled, only abandoned.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`no answer after ${ms} ms`);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
