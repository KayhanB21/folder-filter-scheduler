/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOT_PASS,
  OWN_BLOCKED,
  OWN_OFF,
  PASS,
  PREFER_PROVIDER,
  TEMP,
  UNKNOWN,
  checkMessage,
  combine,
  providerResults,
} from '../../src/auth/check.js';
import { RFC_RECORDS, fakeDns, fixture } from './helpers.js';

const DMARC_EXAMPLE = { '_dmarc.example.com': 'v=DMARC1; p=reject' };
const dns = (extra = {}, options = {}) => fakeDns({ ...RFC_RECORDS, ...DMARC_EXAMPLE, ...extra }, options);
const arh = (value) => `Authentication-Results: ${value}\r\n`;

// --- Own DKIM check ------------------------------------------------------------

test('a valid RSA signature passes DKIM, and DMARC through alignment', async () => {
  const result = await checkMessage(fixture('rfc6376-A.2.eml'), { queryFunction: dns() });
  assert.deepEqual(result.own, { dkim: PASS, dmarc: PASS });
  assert.equal(result.retry, false);
});

test('a valid Ed25519 signature passes DKIM', async () => {
  const result = await checkMessage(fixture('rfc8463-A.3.eml'), { queryFunction: dns() });
  assert.equal(result.own.dkim, PASS);
});

test('a changed body or a changed signed header fails DKIM', async () => {
  for (const name of ['rfc6376-A.2-body_modified.eml', 'rfc6376-A.2-header_subject_modified.eml']) {
    const result = await checkMessage(fixture(name), { queryFunction: dns() });
    assert.deepEqual(result.own, { dkim: NOT_PASS, dmarc: NOT_PASS }, name);
    assert.equal(result.retry, false, name);
  }
});

test('a key of the wrong type fails the signature', async () => {
  // Each signature names the selector of the other algorithm's key.
  const result = await checkMessage(fixture('rfc8463-A.3-key_algo_mismatch.eml'), { queryFunction: dns() });
  assert.equal(result.own.dkim, NOT_PASS);
  assert.equal(result.retry, false);
});

test('a missing key fails DKIM for good, and a DNS error is temporary', async () => {
  const missing = await checkMessage(fixture('rfc6376-A.2.eml'), { queryFunction: fakeDns(DMARC_EXAMPLE) });
  assert.deepEqual(missing.own, { dkim: NOT_PASS, dmarc: NOT_PASS });
  assert.equal(missing.retry, false);

  const failed = await checkMessage(fixture('rfc6376-A.2.eml'), {
    queryFunction: dns({}, { fail: ['brisbane._domainkey.example.com'] }),
  });
  assert.deepEqual(failed.own, { dkim: TEMP, dmarc: TEMP });
  assert.equal(failed.retry, true);
});

test('a DNS error on the DMARC record leaves DMARC temporary but DKIM decided', async () => {
  const result = await checkMessage(fixture('rfc6376-A.2.eml'), {
    queryFunction: dns({}, { fail: ['_dmarc.example.com'] }),
  });
  assert.deepEqual(result.own, { dkim: PASS, dmarc: TEMP });
  assert.equal(result.retry, true);
});

test('unsigned mail fails DKIM, and DMARC without a record', async () => {
  const result = await checkMessage(fixture('yahoo-bulk-spam.eml'), { queryFunction: dns() });
  assert.deepEqual(result.own, { dkim: NOT_PASS, dmarc: NOT_PASS });
});

test('the own check does not run when it is off or blocked', async () => {
  for (const own of [OWN_OFF, OWN_BLOCKED]) {
    const asked = [];
    const result = await checkMessage(fixture('rfc6376-A.2.eml'), { own, queryFunction: dns({}, { asked }) });
    assert.equal(result.own, null);
    assert.deepEqual(asked, []);
  }
});

test('a message that is not a message gets no results and no retry', async () => {
  const result = await checkMessage('no header end', { queryFunction: dns() });
  assert.deepEqual(result, {
    provider: { spf: null, dkim: null, dmarc: null, mailFrom: null },
    own: null,
    retry: false,
  });
});

// --- Provider header -----------------------------------------------------------

test("Yahoo's header parses, and unknown counts as not passing", async () => {
  const result = await checkMessage(fixture('yahoo-bulk-spam.eml'), { own: OWN_OFF });
  assert.deepEqual(result.provider, { spf: NOT_PASS, dkim: NOT_PASS, dmarc: NOT_PASS, mailFrom: null });
});

test('Gmail and Outlook headers parse', () => {
  const gmail = providerResults([
    arh('mx.google.com;\r\n dkim=pass header.i=@a.example header.s=s1;\r\n' +
      ' spf=pass (google.com: domain of x@a.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=x@a.example;\r\n' +
      ' dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=a.example'),
  ]);
  assert.deepEqual(gmail, { spf: PASS, dkim: PASS, dmarc: PASS, mailFrom: 'a.example' });

  // Outlook leaves out the server name and adds compauth.
  const outlook = providerResults([
    arh('spf=fail (sender IP is 192.0.2.1)\r\n smtp.mailfrom=b.example; dkim=none (message not signed)\r\n' +
      ' header.d=none;dmarc=fail action=none header.from=b.example;compauth=fail\r\n reason=001'),
  ]);
  assert.deepEqual(outlook, { spf: NOT_PASS, dkim: NOT_PASS, dmarc: NOT_PASS, mailFrom: null });
});

test('only the topmost header counts, so a forged lower one adds nothing', async () => {
  const result = await checkMessage(fixture('yahoo-forged-pass.eml'), { own: OWN_OFF });
  assert.deepEqual(result.provider, { spf: NOT_PASS, dkim: NOT_PASS, dmarc: NOT_PASS, mailFrom: null });

  // A forged header that names the provider's own server is ignored too.
  const lines = [
    arh('mta.yahoo.com; dkim=unknown; spf=softfail smtp.mailfrom=c.example'),
    arh('mta.yahoo.com; dkim=pass header.d=c.example; spf=pass smtp.mailfrom=c.example'),
  ];
  assert.equal(providerResults(lines).dkim, NOT_PASS);
});

test('trusted servers pick the topmost header from one of them', async () => {
  const result = await checkMessage(fixture('yahoo-forged-pass.eml'), {
    own: OWN_OFF,
    trustedServers: ['mx.example.net'],
  });
  assert.deepEqual(result.provider, { spf: PASS, dkim: PASS, dmarc: PASS, mailFrom: 'bank.example' });

  const none = await checkMessage(fixture('yahoo-forged-pass.eml'), { own: OWN_OFF, trustedServers: ['mx.other.example'] });
  assert.deepEqual(none.provider, { spf: null, dkim: null, dmarc: null, mailFrom: null });
});

test('an unreadable topmost header means no provider results', () => {
  const lines = [arh('mta.yahoo.com; ==='), arh('mta.yahoo.com; dkim=pass header.d=c.example')];
  assert.deepEqual(providerResults(lines), { spf: null, dkim: null, dmarc: null, mailFrom: null });
});

test("the provider's SPF pass counts toward own DMARC when its domain aligns", async () => {
  const raw = fixture('yahoo-bulk-spam.eml').replace(
    'Authentication-Results: mta.yahoo.com;\n dkim=unknown;\n spf=softfail',
    'Authentication-Results: mta.yahoo.com;\n dkim=unknown;\n spf=pass',
  );
  const records = { '_dmarc.bb4u.ne.jp': 'v=DMARC1; p=none' };
  const result = await checkMessage(raw, { queryFunction: fakeDns(records) });
  assert.equal(result.provider.spf, PASS);
  assert.deepEqual(result.own, { dkim: NOT_PASS, dmarc: PASS });
});

// --- Combining the two sources -------------------------------------------------

const provider = { spf: PASS, dkim: PASS, dmarc: PASS, mailFrom: null };

test('by default the own result wins, and SPF comes from the provider', () => {
  const own = { dkim: NOT_PASS, dmarc: NOT_PASS };
  assert.deepEqual(combine({ provider, own }), { spf: PASS, dkim: NOT_PASS, dmarc: NOT_PASS, disagree: 2 });
});

test('a temporary own result is unknown, even when the provider has one', () => {
  const own = { dkim: TEMP, dmarc: PASS };
  assert.deepEqual(combine({ provider, own }), { spf: PASS, dkim: UNKNOWN, dmarc: PASS, disagree: 0 });
});

test('preferring the provider uses the own result only where the header is silent', () => {
  const own = { dkim: NOT_PASS, dmarc: NOT_PASS };
  const silent = { spf: null, dkim: null, dmarc: PASS, mailFrom: null };
  assert.deepEqual(
    combine({ provider: silent, own }, { prefer: PREFER_PROVIDER }),
    { spf: UNKNOWN, dkim: NOT_PASS, dmarc: PASS, disagree: 1 },
  );
});

test('with the own check off the provider is the only source', () => {
  assert.deepEqual(
    combine({ provider, own: null }, { ownState: OWN_OFF }),
    { spf: PASS, dkim: PASS, dmarc: PASS, disagree: 0 },
  );
  assert.deepEqual(
    combine({ provider: null, own: null }, { ownState: OWN_OFF }),
    { spf: UNKNOWN, dkim: UNKNOWN, dmarc: UNKNOWN, disagree: 0 },
  );
});

test('with the own check blocked DKIM and DMARC are unknown', () => {
  assert.deepEqual(
    combine({ provider, own: null }, { ownState: OWN_BLOCKED }),
    { spf: PASS, dkim: UNKNOWN, dmarc: UNKNOWN, disagree: 0 },
  );
});
