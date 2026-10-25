/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readFileSync } from 'node:fs';
import { PacketType, RecordType, decode, encode } from '../../src/auth/thirdparty/dns-message/dns-message.mjs';

/**
 * Test helpers for the auth checks. No test runs from here.
 *
 * The keys are the published examples from RFC 6376 appendix A and RFC 8463
 * appendix A, as DKIM Verifier's test/helpers/dnsStub.mjs.js lists them.
 */

/** A message from test/auth/data as a binary string, as getRaw returns it. */
export const fixture = (name) => readFileSync(new URL(`./data/${name}`, import.meta.url), 'latin1');

export const RFC_RECORDS = Object.freeze({
  'brisbane._domainkey.example.com':
    'v=DKIM1; p=' +
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDwIRP/UC3SBsEmGqZ9ZJW3/DkM' +
    'oGeLnQg1fWn7/zYtIxN2SnFCjxOCKG9v3b4jYfcTNh5ijSsq631uBItLa7od+v/R' +
    'tdC2UzJ1lWT947qR+Rcac2gbto/NMqJ0fzfVjH4OuKhitdY9tf6mcwGjaNBcWToI' +
    'MmPSPDdQPNUYckcQ2QIDAQAB',
  'brisbane._domainkey.football.example.com': 'v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=',
  'test._domainkey.football.example.com':
    'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWR' +
    'iGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutAC' +
    'DfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3' +
    'Ip3G+2kryOTIKT+l/K4w3QIDAQAB',
});

export const RCODE_SERVFAIL = 2;

/**
 * A DoH query function that answers from `records`, a map of name to a TXT
 * string or an array of them. A name in `fail` answers SERVFAIL. Every name
 * asked for is pushed to `asked`.
 */
export function fakeDns(records = {}, { fail = [], asked = [] } = {}) {
  return async (query) => {
    const { questions } = decode(query);
    const { name } = questions[0];
    asked.push(name);
    const failed = fail.includes(name);
    const found = failed ? undefined : records[name];
    const values = found === undefined ? [] : [found].flat();
    return encode({
      id: 0,
      type: PacketType.RESPONSE,
      flags: 0,
      rtype: failed ? RCODE_SERVFAIL : values.length > 0 ? 0 : 3,
      questions,
      answers: values.map((v) => ({ name, type: RecordType.TXT, data: [v] })),
    });
  };
}
