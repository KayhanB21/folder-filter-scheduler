/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import txt, { RCODE, checkForErrors, dohQuery } from '../../src/auth/doh.js';
import { DKIM_TempError } from '../../src/auth/errors.js';
import { fakeDns } from './helpers.js';

/** A fetch that answers like a DoH server, from `fakeDns`. */
function fakeFetch(records, { status = 200, type = 'application/dns-message', calls = [] } = {}) {
  const dns = fakeDns(records);
  return async (url, init) => {
    calls.push({ url, init });
    const query = Uint8Array.from(atob(new URL(url).searchParams.get('dns').replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
    const body = await dns(query);
    return {
      ok: status === 200,
      status,
      headers: { get: () => type },
      arrayBuffer: async () => body,
    };
  };
}

test('a TXT lookup goes to the server as an RFC 8484 GET with a time limit', async () => {
  const calls = [];
  const query = dohQuery('https://dns.example/dns-query', { fetchImpl: fakeFetch({ 'a.example': 'hello' }, { calls }) });
  const result = await txt('a.example', query);
  assert.deepEqual(result.data, ['hello']);
  assert.equal(result.rcode, RCODE.NoError);
  assert.match(calls[0].url, /^https:\/\/dns\.example\/dns-query\?dns=[A-Za-z0-9_-]+$/);
  assert.equal(calls[0].init.headers.Accept, 'application/dns-message');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('not found is an answer; a server failure is temporary', async () => {
  const query = dohQuery('https://dns.example/dns-query', { fetchImpl: fakeFetch({}) });
  const result = await txt('missing.example', query);
  assert.equal(result.rcode, RCODE.NXDomain);
  checkForErrors(result);
  assert.throws(() => checkForErrors({ ...result, rcode: RCODE.ServFail }), DKIM_TempError);
});

test('a bad HTTP status, a wrong content type, or a network error is temporary', async () => {
  for (const options of [{ status: 503 }, { type: 'text/html' }]) {
    const query = dohQuery('https://dns.example/dns-query', { fetchImpl: fakeFetch({}, options) });
    await assert.rejects(txt('a.example', query), DKIM_TempError, JSON.stringify(options));
  }
  let attempts = 0;
  const offline = dohQuery('https://dns.example/dns-query', {
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError('NetworkError');
    },
  });
  await assert.rejects(txt('a.example', offline), DKIM_TempError);
  assert.equal(attempts, 2);
});
