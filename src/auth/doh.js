/**
 * DNS Queries over HTTPS (DoH) according to RFC 8484
 * https://datatracker.ietf.org/doc/html/rfc8484
 *
 * Copyright (c) 2026 Philippe Lieser
 *
 * This software is licensed under the terms of the MIT License.
 *
 * The above copyright and license notice shall be
 * included in all copies or substantial portions of the Software.
 */

// @ts-check
/* eslint-disable no-magic-numbers */

/*
 * Changed for Folder Filter Scheduler:
 * - The server URL and the time limit are parameters, not preferences.
 * - Each request has a time limit, and a network error is retried once.
 * - RCODE and checkForErrors come from DKIM Verifier's modules/dns.mjs.js.
 */

/**
 * The result of a TXT query.
 *
 * @typedef {object} DnsTxtResult
 * @property {string[]|null} data Array of txt rdata items, or null if error or no entry in DNS
 * @property {number} rcode DNS error code
 * @property {boolean} secure true if result is secure.
 * @property {boolean} bogus true if a security failure happened.
 */

import { PacketFlag, PacketType, RecordType, decode, encode } from "./thirdparty/dns-message/dns-message.mjs";
import { encodeBase64Url, sleep } from "./utils.js";
import { DKIM_TempError } from "./errors.js";
import Logging from "./log.js";

const log = Logging.getLogger("doh");

/**
 * The part the DNS header containing the flags and codes (third and fourth byte).
 *
 * @typedef {object} DnsHeaderFlagsAndCodes
 * @property {boolean} QR
 * @property {number} Opcode
 * @property {boolean} AA
 * @property {boolean} TC
 * @property {boolean} RD
 * @property {boolean} RA
 * @property {boolean} Z
 * @property {boolean} AD
 * @property {boolean} CD
 * @property {number} RCODE
 */

/**
 * Decode DNS flags and codes.
 *
 * See the following for the flags definition:
 * - <https://datatracker.ietf.org/doc/html/rfc1035#section-4.1.1>.
 * - <https://datatracker.ietf.org/doc/html/rfc2065#section-6.1>.
 *
 * @param {number} flags - The two bytes of flags as a big endian number.
 * @returns {DnsHeaderFlagsAndCodes}
 */
function flagsDecode(flags) {
	return {
		QR: ((flags >> 15) & 0x1) === 1,
		Opcode: (flags >> 11) & 0x7,
		AA: ((flags >> 10) & 0x1) === 1,
		TC: ((flags >> 9) & 0x1) === 1,
		RD: ((flags >> 8) & 0x1) === 1,
		RA: ((flags >> 7) & 0x1) === 1,
		Z: ((flags >> 6) & 0x1) === 1,
		AD: ((flags >> 5) & 0x1) === 1,
		CD: ((flags >> 4) & 0x1) === 1,
		RCODE: flags & 0xF,
	};
}

/** DNS response codes, from DKIM Verifier's modules/dns.mjs.js. */
export const RCODE = Object.freeze({
	NoError: 0, // No Error [RFC1035]
	FormErr: 1, // Format Error [RFC1035]
	ServFail: 2, // Server Failure [RFC1035]
	NXDomain: 3, // Non-Existent Domain [RFC1035]
	NotImp: 4, // Non-Existent Domain [RFC1035]
	Refused: 5, // Query Refused [RFC1035]
});

/**
 * Throw a temporary error for any answer other than "found" or "not found".
 *
 * @param {DnsTxtResult} dnsResult
 * @returns {void}
 * @throws {DKIM_TempError}
 */
export function checkForErrors(dnsResult) {
	if (dnsResult.bogus) {
		throw new DKIM_TempError("DKIM_DNSERROR_DNSSEC_BOGUS");
	}
	if (dnsResult.rcode !== RCODE.NoError && dnsResult.rcode !== RCODE.NXDomain) {
		throw new DKIM_TempError("DKIM_DNSERROR_SERVER_ERROR");
	}
}

/**
 * A query function that asks a DoH server using the GET method.
 *
 * @param {string} server - URL of the DoH endpoint.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Time limit for one request.
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {QueryFunction}
 */
export function dohQuery(server, { timeoutMs = 5_000, fetchImpl = fetch } = {}) {
	return async (query) => {
		const params = new URLSearchParams();
		// RFC 8484 section 6:
		// When using the GET method, the data payload for this media type MUST
		// be encoded with base64url [RFC4648] and then provided as a variable
		// named "dns" to the URI Template expansion. Padding characters for
		// base64url MUST NOT be included.
		params.append("dns", encodeBase64Url(query, true));

		let httpResponse;
		let attempt = 1;
		while (!httpResponse) {
			try {
				httpResponse = await fetchImpl(`${server}?${params}`, {
					method: "GET",
					headers: {
						Accept: "application/dns-message",
					},
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (error) {
				log.error(`Failed to fetch DoH server (attempt ${attempt})`, error);
				if (attempt >= 2) {
					throw new DKIM_TempError("DKIM_DNSERROR_SERVER_ERROR");
				}
				await sleep(250);
				++attempt;
			}
		}
		if (!httpResponse.ok) {
			log.error(`DNS server responded with response status: ${httpResponse.status}`);
			throw new DKIM_TempError("DKIM_DNSERROR_UNKNOWN");
		}
		const contentType = httpResponse.headers.get("content-type");
		if (!contentType || !contentType.includes("application/dns-message")) {
			log.error(`DNS server responded with unexpected content type: ${contentType}`);
			throw new DKIM_TempError("DKIM_DNSERROR_UNKNOWN");
		}
		return httpResponse.arrayBuffer();
	};
}

/**
 * @typedef {(query: Uint8Array<ArrayBufferLike>) => Promise<ArrayBuffer>} QueryFunction
 */

/**
 * Perform TXT resolution of the target name.
 *
 * @param {string} name
 * @param {QueryFunction} queryFunction
 * @returns {Promise<DnsTxtResult>}
 * @throws {DKIM_TempError} if no DNS response could be retrieved.
 */
export default async function txt(name, queryFunction) {
	log.debug(`Resolving '${name}'`);
	const query = encode({
		// RFC 8484 section 4.1 - DoH clients [...] SHOULD use a DNS ID of 0 in every DNS request.
		id: 0,
		type: PacketType.QUERY,
		flags: PacketFlag.RECURSION_DESIRED | PacketFlag.AUTHENTIC_DATA,
		questions: [{
			name,
			type: RecordType.TXT,
		}],
	});
	const encodedResponse = await queryFunction(query);
	const response = decode(encodedResponse);

	if (response.type !== PacketType.RESPONSE) {
		log.error(`DNS server responded with unexpected packet type: ${response.type}`);
		throw new DKIM_TempError("DKIM_DNSERROR_UNKNOWN");
	}

	let txtData = null;
	if (response.answers) {
		txtData = [];
		for (const answer of response.answers) {
			if (answer?.type === RecordType.CNAME) {
				// Ignore CNAME records.
				continue;
			}
			if (answer?.type !== RecordType.TXT) {
				log.error(`DNS answer has unexpected type: ${answer?.type}`);
				throw new DKIM_TempError("DKIM_DNSERROR_UNKNOWN");
			}
			txtData.push(answer.data.join(""));
		}
	}

	const flags = flagsDecode(response.flags ?? 0);

	return {
		data: txtData,
		rcode: response.rtype ?? PacketFlag.SERVFAIL,
		secure: flags.AD,
		bogus: false,
	};
}
