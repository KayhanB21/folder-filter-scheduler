/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import RfcParser from './rfc.js';
import txt, { checkForErrors } from './doh.js';
import psl from './thirdparty/psl/psl.mjs';

/**
 * DMARC, the part a mail client can do after delivery (RFC 7489).
 *
 * Record parsing follows DKIM Verifier's modules/dkim/dmarc.mjs.js. DKIM
 * Verifier stops at "should this domain sign", so the alignment check is new
 * here. It also reads `adkim` correctly: the upstream code always uses
 * relaxed alignment.
 *
 * DMARC passes when the domain publishes a record and an identifier that
 * passed aligns with the From domain. For DKIM that identifier is the `d=`
 * of a valid signature. For SPF it is the envelope sender (`smtp.mailfrom`),
 * which only the receiving server knows, so the caller passes the provider's
 * SPF result in.
 *
 * `pct` and `p` are left out on purpose: they tell a receiver what to do with
 * a failure, not whether the message failed.
 */

/** The organizational domain, through the Public Suffix List. */
export function organizationalDomain(domain) {
  const d = String(domain ?? '').toLowerCase().replace(/\.$/, '');
  const parsed = psl.parse(d);
  return parsed.domain ?? parsed.tld ?? d;
}

/**
 * True when `a` and `b` align: equal in strict mode, or sharing an
 * organizational domain in relaxed mode.
 */
export function aligned(a, b, mode) {
  const x = String(a ?? '').toLowerCase().replace(/\.$/, '');
  const y = String(b ?? '').toLowerCase().replace(/\.$/, '');
  if (!x || !y) return false;
  if (x === y) return true;
  return mode !== 's' && organizationalDomain(x) === organizationalDomain(y);
}

/**
 * Parse one DMARC TXT record. Returns null for anything that is not a valid
 * DMARC1 record, which DMARC treats the same as no record.
 */
export function parseDmarcRecord(text) {
  const tags = RfcParser.parseTagValueList(String(text ?? ''));
  if (!(tags instanceof Map)) return null;
  // v=DMARC1 must be the first tag (RFC 7489 section 6.3).
  if (tags.keys().next().value !== 'v' || tags.get('v') !== 'DMARC1') return null;
  const p = tags.get('p');
  if (!['none', 'quarantine', 'reject'].includes(p)) return null;
  const mode = (value) => (value === 's' ? 's' : 'r');
  return { p, adkim: mode(tags.get('adkim')), aspf: mode(tags.get('aspf')) };
}

/** The DMARC records at one name. Throws DKIM_TempError on a DNS failure. */
async function recordsAt(name, queryFunction) {
  const result = await txt(name, queryFunction);
  checkForErrors(result);
  return (result.data ?? []).map(parseDmarcRecord).filter(Boolean);
}

/**
 * Find the policy for a From domain: at the domain itself, then at its
 * organizational domain. More than one record at a name means no policy.
 *
 * @returns {Promise<{p: string, adkim: string, aspf: string}|null>}
 * @throws {DKIM_TempError}
 */
export async function findDmarcRecord(fromDomain, queryFunction) {
  const domain = String(fromDomain ?? '').toLowerCase();
  let records = await recordsAt(`_dmarc.${domain}`, queryFunction);
  if (records.length === 0) {
    const org = organizationalDomain(domain);
    if (org && org !== domain) records = await recordsAt(`_dmarc.${org}`, queryFunction);
  }
  return records.length === 1 ? records[0] : null;
}

/**
 * The DMARC result for a message.
 *
 * @param {object} input
 * @param {string|null} input.fromDomain the RFC 5322 From domain
 * @param {string[]} input.dkimDomains the `d=` of every signature that passed
 * @param {boolean} input.spfPass the provider's SPF result was pass
 * @param {string|null} input.mailFromDomain the provider's `smtp.mailfrom` domain
 * @param {Function} input.queryFunction a DoH query function, see doh.js
 * @returns {Promise<boolean>} true when DMARC passes
 * @throws {DKIM_TempError} when the record could not be read
 */
export async function dmarcPasses({ fromDomain, dkimDomains, spfPass, mailFromDomain, queryFunction }) {
  if (!fromDomain) return false;
  const record = await findDmarcRecord(fromDomain, queryFunction);
  if (!record) return false;
  if (dkimDomains.some((d) => aligned(d, fromDomain, record.adkim))) return true;
  return spfPass && aligned(mailFromDomain, fromDomain, record.aspf);
}
