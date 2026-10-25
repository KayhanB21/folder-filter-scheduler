/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aligned,
  dmarcPasses,
  findDmarcRecord,
  organizationalDomain,
  parseDmarcRecord,
} from '../../src/auth/dmarc.js';
import { DKIM_TempError } from '../../src/auth/errors.js';
import { fakeDns } from './helpers.js';

test('the organizational domain follows the Public Suffix List', () => {
  assert.equal(organizationalDomain('news.example.com'), 'example.com');
  assert.equal(organizationalDomain('mail.bb4u.ne.jp'), 'bb4u.ne.jp');
  assert.equal(organizationalDomain('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(organizationalDomain('Example.COM.'), 'example.com');
});

test('relaxed alignment shares an organizational domain; strict needs the same name', () => {
  assert.equal(aligned('news.example.com', 'example.com', 'r'), true);
  assert.equal(aligned('news.example.com', 'example.com', 's'), false);
  assert.equal(aligned('EXAMPLE.com', 'example.com', 's'), true);
  assert.equal(aligned('example.net', 'example.com', 'r'), false);
  // Two customers of one public suffix do not align.
  assert.equal(aligned('a.co.uk', 'b.co.uk', 'r'), false);
  assert.equal(aligned('', 'example.com', 'r'), false);
});

test('a record parses only as a valid DMARC1 record', () => {
  assert.deepEqual(parseDmarcRecord('v=DMARC1; p=reject'), { p: 'reject', adkim: 'r', aspf: 'r' });
  // DKIM Verifier always reads adkim as relaxed; strict must stay strict.
  assert.deepEqual(parseDmarcRecord('v=DMARC1; p=none; adkim=s; aspf=s'), { p: 'none', adkim: 's', aspf: 's' });
  for (const text of ['p=reject; v=DMARC1', 'v=DMARC2; p=reject', 'v=DMARC1', 'v=DMARC1; p=maybe', 'v=spf1 -all', '']) {
    assert.equal(parseDmarcRecord(text), null, text);
  }
});

test('the record comes from the From domain, then from its organizational domain', async () => {
  const asked = [];
  const dns = fakeDns({ '_dmarc.example.com': 'v=DMARC1; p=reject' }, { asked });
  assert.deepEqual(await findDmarcRecord('news.example.com', dns), { p: 'reject', adkim: 'r', aspf: 'r' });
  assert.deepEqual(asked, ['_dmarc.news.example.com', '_dmarc.example.com']);
});

test('two records at one name mean no policy', async () => {
  const dns = fakeDns({ '_dmarc.example.com': ['v=DMARC1; p=reject', 'v=DMARC1; p=none'] });
  assert.equal(await findDmarcRecord('example.com', dns), null);
});

test('a DNS error is temporary', async () => {
  const dns = fakeDns({}, { fail: ['_dmarc.example.com'] });
  await assert.rejects(findDmarcRecord('example.com', dns), DKIM_TempError);
});

test('DMARC passes on an aligned DKIM pass or an aligned SPF pass', async () => {
  const dns = fakeDns({ '_dmarc.example.com': 'v=DMARC1; p=reject; aspf=s' });
  const base = { fromDomain: 'example.com', dkimDomains: [], spfPass: false, mailFromDomain: null, queryFunction: dns };
  assert.equal(await dmarcPasses(base), false);
  assert.equal(await dmarcPasses({ ...base, dkimDomains: ['mail.example.com'] }), true);
  assert.equal(await dmarcPasses({ ...base, dkimDomains: ['other.example'] }), false);
  assert.equal(await dmarcPasses({ ...base, spfPass: true, mailFromDomain: 'example.com' }), true);
  // aspf=s: a subdomain does not align for SPF.
  assert.equal(await dmarcPasses({ ...base, spfPass: true, mailFromDomain: 'bounce.example.com' }), false);
  assert.equal(await dmarcPasses({ ...base, spfPass: false, mailFromDomain: 'example.com' }), false);
});

test('DMARC fails without a record or without a From domain', async () => {
  const dns = fakeDns({});
  const input = { fromDomain: 'example.com', dkimDomains: ['example.com'], spfPass: true, mailFromDomain: 'example.com', queryFunction: dns };
  assert.equal(await dmarcPasses(input), false);
  assert.equal(await dmarcPasses({ ...input, fromDomain: null }), false);
});
