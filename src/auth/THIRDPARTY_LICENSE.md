# Third-party code in `src/auth`

The files in this folder that carry a Philippe Lieser copyright notice come from
[DKIM Verifier](https://github.com/lieser/dkim_verifier), release 6.4.0, commit
`727c54b`. They are under the MIT license in
[`LICENSE-dkim-verifier.txt`](LICENSE-dkim-verifier.txt).

| File | Source in DKIM Verifier | Changes |
| --- | --- | --- |
| `errors.js` | `modules/error.mjs.js` | None |
| `rfc.js` | `modules/rfcParser.mjs.js` | Import paths |
| `utils.js` | `modules/utils.mjs.js` | None |
| `message.js` | `modules/msgParser.mjs.js` | Import paths |
| `arh.js` | `modules/arhParser.mjs.js` | Import paths. Relaxed parsing skips tokens without a `ptype.` prefix, as Yahoo writes them. |
| `dkim.js` | `modules/dkim/verifier.mjs.js` | Fixed preferences at DKIM Verifier's defaults. The caller passes the key store. |
| `crypto.js` | `modules/dkim/crypto.mjs.js` | Ed25519 through WebCrypto, not tweetnacl |
| `doh.js` | `modules/doh.mjs`, plus `RCODE` and `checkForErrors` from `modules/dns.mjs.js` | Server URL and time limit as parameters. One retry. |

`log.js` replaces DKIM Verifier's logging module with one that drops every
message, because the ported code logs domains and header text.

The libraries in `thirdparty/` are unchanged copies of the npm packages that
DKIM Verifier bundles:

| Library | Version | License |
| --- | --- | --- |
| [dns-message](https://github.com/kitten/dns-message) | 1.1.1 | MIT, in `thirdparty/dns-message/LICENSE.md` |
| [psl](https://github.com/lupomontero/psl) | 1.15.0 | MIT, in `thirdparty/psl/LICENSE` |
| [Punycode.js](https://github.com/mathiasbynens/punycode.js), bundled in psl | | MIT |

The test messages `test/auth/data/rfc6376-*.eml` and `rfc8463-*.eml` come from
DKIM Verifier's `test/data/` folder. They are the examples from RFC 6376 and
RFC 8463.
