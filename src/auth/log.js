/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A silent stand-in for DKIM Verifier's logging module.
 *
 * The ported code logs domains, selectors, and header text. Folder Filter
 * Scheduler never logs those, because the log ends up in shared reports. So
 * every call is dropped here, and background.js logs counts instead.
 */
const quiet = Object.freeze({
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
});

export default {
  getLogger() {
    return quiet;
  },
};
