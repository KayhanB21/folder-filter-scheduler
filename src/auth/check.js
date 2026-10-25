/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import ArhParser from './arh.js';
import MsgParser from './message.js';
import Verifier from './dkim.js';
import txt, { checkForErrors } from './doh.js';
import { DKIM_SigError, DKIM_TempError } from './errors.js';
import { dmarcPasses } from './dmarc.js';

/**
 * SPF, DKIM, and DMARC for one raw message.
 *
 * Pure and free of extension APIs, like headers.js: the caller passes the raw
 * message and a DNS query function, so the whole policy is unit-testable.
 *
 * Two sources, kept apart until the last step:
 *
 * - The provider: the `Authentication-Results` header your mail server added.
 *   A sender can add one too, so only the topmost header is trusted. If
 *   `trustedServers` is set, the topmost header from one of them is.
 * - The own check: DKIM verified here, with the key fetched over DNS, and
 *   DMARC from that result. SPF has no own check: it needs the IP address that
 *   connected to your provider, and only the provider saw it.
 *
 * `combine` turns the two into the three results a condition reads. It is
 * separate from `checkMessage` so the cache can keep the sources and a change
 * of `prefer` needs no new download.
 */

export const PASS = 'pass';
export const NOT_PASS = 'notPass';
/** The add-on could not decide. A condition never matches on it. */
export const UNKNOWN = 'unknown';
/** The own check hit a DNS error. Retried; `combine` reads it as unknown. */
export const TEMP = 'temp';

export const PREFER_OWN = 'own';
export const PREFER_PROVIDER = 'provider';

/** The own check is off, so `combine` uses the provider alone. */
export const OWN_OFF = 'off';
/** The own check is on but has no DNS access, so it cannot run. */
export const OWN_BLOCKED = 'blocked';
export const OWN_ON = 'on';

const AUTH_RESULTS = 'authentication-results';

/** The value of a raw header line, without its name. */
function headerValue(line) {
  return line.slice(line.indexOf(':') + 1);
}

/** The domain of an address or of an `smtp.mailfrom` value. */
function domainOf(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  return (at === -1 ? text : text.slice(at + 1)) || null;
}

/** The results of one method in one source: pass, not pass, or none given. */
function resultOf(resinfos) {
  if (resinfos.length === 0) return null;
  return resinfos.some((r) => r.result === PASS) ? PASS : NOT_PASS;
}

/**
 * The provider's results, from the raw `Authentication-Results` lines in
 * message order, topmost first. Only the topmost header counts, or with
 * `trustedServers` set, the topmost header from one of those servers. A
 * method that header doesn't mention is null. `mailFrom` is the envelope
 * sender domain of a passing SPF check.
 *
 * Parsing is relaxed: providers write results that the RFC does not list,
 * such as Yahoo's `dkim=unknown`, and anything other than pass is not a pass.
 */
export function providerResults(lines, trustedServers = []) {
  const parsed = [];
  for (const line of lines ?? []) {
    try {
      parsed.push(ArhParser.parse(line, true, true));
    } catch {
      // An unreadable header can't be trusted or used. When it is the topmost
      // one, nothing below it is trusted either.
      parsed.push(null);
    }
  }

  // One header only. A sender can add a header that names your provider's
  // server too, so merging every header with that name would let theirs add
  // a pass. The topmost is the last one added, by your provider.
  const trusted = trustedServers.map((s) => s.toLowerCase());
  const chosen = trusted.length > 0
    ? parsed.find((arh) => arh && trusted.includes(arh.authserv_id.toLowerCase()))
    : parsed[0];

  const resinfos = chosen?.resinfo ?? [];
  const of = (method) => resinfos.filter((r) => r.method === method);
  const spf = of('spf');
  const passingSpf = spf.find((r) => r.result === PASS);
  return {
    spf: resultOf(spf),
    dkim: resultOf(of('dkim')),
    dmarc: resultOf(of('dmarc')),
    mailFrom: domainOf(passingSpf?.properties?.smtp?.mailfrom),
  };
}

/** Key lookups in the shape the DKIM verifier expects, over `queryFunction`. */
function keyStoreFor(queryFunction) {
  return {
    async fetchKey(sdid, selector) {
      const result = await txt(`${selector}._domainkey.${sdid}`, queryFunction);
      checkForErrors(result);
      if (!result.data?.[0]) throw new DKIM_SigError('DKIM_SIGERROR_NOKEY');
      return { key: result.data[0], secure: result.secure };
    },
  };
}

/**
 * Run the own check: DKIM, then DMARC. Each is pass, not pass, or temp.
 */
async function ownResults(msg, from, provider, queryFunction) {
  const verifier = new Verifier(keyStoreFor(queryFunction));
  const { signatures } = await verifier.verify({
    headerFields: msg.headers,
    bodyPlain: msg.body,
    from: from ?? '',
  });
  const passed = signatures.filter((s) => s.result === 'SUCCESS');
  let dkim = NOT_PASS;
  if (passed.length > 0) dkim = PASS;
  else if (signatures.some((s) => s.result === 'TEMPFAIL')) dkim = TEMP;

  let dmarc;
  try {
    const pass = await dmarcPasses({
      fromDomain: domainOf(from),
      dkimDomains: passed.map((s) => s.sdid).filter(Boolean),
      spfPass: provider.spf === PASS,
      mailFromDomain: provider.mailFrom,
      queryFunction,
    });
    // A failed signature lookup could still have aligned, so only a pass
    // stands while DKIM is temp.
    dmarc = pass ? PASS : dkim === TEMP ? TEMP : NOT_PASS;
  } catch (e) {
    if (!(e instanceof DKIM_TempError)) throw e;
    dmarc = TEMP;
  }
  return { dkim, dmarc };
}

/**
 * Check one raw message. `queryFunction` is a DoH query function (doh.js), or
 * null when the own check does not run. `own` says why it does not: OWN_OFF
 * or OWN_BLOCKED.
 *
 * Returns the two sources. `own` is null when the own check did not run.
 * `retry` is true when the own check hit a temporary error. A message that
 * can't be parsed at all gets no results from either source.
 *
 * @returns {Promise<{provider: object, own: object|null, retry: boolean}>}
 */
export async function checkMessage(raw, { own = OWN_ON, queryFunction = null, trustedServers = [] } = {}) {
  let msg;
  try {
    msg = MsgParser.parseMsg(String(raw ?? ''));
  } catch {
    return { provider: providerResults([]), own: null, retry: false };
  }

  const provider = providerResults(msg.headers.get(AUTH_RESULTS) ?? [], trustedServers);
  if (own !== OWN_ON || !queryFunction) return { provider, own: null, retry: false };

  let from = null;
  try {
    from = MsgParser.parseFromHeader(msg.headers.get('from')?.[0] ?? '', true);
  } catch {
    // No usable From: DKIM still verifies, and DMARC can't pass.
  }
  const ownResult = await ownResults(msg, from, provider, queryFunction);
  return {
    provider,
    own: ownResult,
    retry: ownResult.dkim === TEMP || ownResult.dmarc === TEMP,
  };
}

/**
 * The three results a condition reads, from the two sources.
 *
 * - SPF comes from the provider alone.
 * - With PREFER_OWN, the own result wins. A temp own result is unknown, even
 *   when the provider has one: the own check exists because that header can
 *   be forged.
 * - With PREFER_PROVIDER, the provider wins, and the own result fills in for
 *   a method the provider didn't report.
 * - With the own check off, the provider is the only source.
 * - With the own check blocked, DKIM and DMARC are unknown.
 *
 * `disagree` counts the methods where both sources gave a definite result and
 * the results differ, for the diagnostics log.
 */
export function combine({ provider, own }, { prefer = PREFER_OWN, ownState = OWN_ON } = {}) {
  const definite = (r) => (r === PASS || r === NOT_PASS ? r : null);
  const pick = (method) => {
    const theirs = definite(provider?.[method]);
    if (ownState === OWN_OFF) return theirs ?? UNKNOWN;
    if (ownState === OWN_BLOCKED || !own) return UNKNOWN;
    const ours = definite(own[method]);
    if (prefer === PREFER_PROVIDER) return theirs ?? ours ?? UNKNOWN;
    return ours ?? UNKNOWN;
  };

  let disagree = 0;
  for (const method of ['dkim', 'dmarc']) {
    const theirs = definite(provider?.[method]);
    const ours = definite(own?.[method]);
    if (theirs && ours && theirs !== ours) disagree += 1;
  }

  return {
    spf: definite(provider?.spf) ?? UNKNOWN,
    dkim: pick('dkim'),
    dmarc: pick('dmarc'),
    disagree,
  };
}
