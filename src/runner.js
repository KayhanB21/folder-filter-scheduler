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
 */

/**
 * @param {(reason: string, context: object) => Promise<number>} run
 * @returns {{request: (reason: string, context?: object) => Promise<number>, isRunning: () => boolean}}
 */
export function createRunner(run) {
  let inFlight = null;
  let queued = null; // { reason, folderIds: Set|null, promise, resolve, reject }

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

  function start(reason, folderIds) {
    // Called synchronously, so `isRunning()` is true before this returns: the
    // alarm and a new-mail timer can fire in the same tick, and the second must
    // see the first.
    let started;
    try {
      started = Promise.resolve(run(reason, { folderIds }));
    } catch (e) {
      started = Promise.reject(e);
    }

    inFlight = started.finally(() => {
      inFlight = null;
      const next = queued;
      queued = null;
      if (next) start(next.reason, next.folderIds).then(next.resolve, next.reject);
    });
    return inFlight;
  }

  function request(reason, { folderIds = null } = {}) {
    if (!inFlight) return start(reason, folderIds);

    if (!queued) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      queued = { reason, folderIds, promise, resolve, reject };
      return promise;
    }

    // Already something pending: widen it rather than adding another run.
    queued.folderIds = mergeScope(queued.folderIds, folderIds);
    if (isManual(reason) && !isManual(queued.reason)) {
      queued.reason = reason;
      queued.folderIds = null; // a manual run is never folder-scoped
    }
    return queued.promise;
  }

  return { request, isRunning: () => inFlight !== null };
}
