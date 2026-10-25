/**
 * Unified crypto interface for Thunderbird/Browser and Node.
 *
 * Copyright (c) 2020-2023;2025 Philippe Lieser
 *
 * This software is licensed under the terms of the MIT License.
 *
 * The above copyright and license notice shall be
 * included in all copies or substantial portions of the Software.
 */

// @ts-check

import { DKIM_SigError } from "./errors.js";
import Logging from "./log.js";

const log = Logging.getLogger("Crypto");

/**
 * Converts a string to an ArrayBuffer.
 * Characters >255 have their hi-byte silently ignored.
 *
 * @param {string} str - binary string
 * @returns {ArrayBufferView<ArrayBuffer>}
 */
function strToArrayBuffer(str) {
	const buffer = new Uint8Array(str.length);
	for (let i = 0; i < str.length; i++) {
		// eslint-disable-next-line no-magic-numbers, unicorn/prefer-code-point
		buffer[i] = str.charCodeAt(i) & 0xFF;
	}
	return buffer;
}

/**
 * @protected
 * @param {string} str
 * @returns {ArrayBufferView<ArrayBuffer>}
 */
function decodeBase64(str) {
	return strToArrayBuffer(atob(str));
}

/**
 * @param {Uint8Array} data
 * @returns {string}
 */
function encodeBase64(data) {
	return btoa(String.fromCodePoint(...data));
}

/**
 * Convert a digest name used in DKIM to the one used by the Web Crypto API.
 *
 * @param {string} algorithm - algorithm name used by DKIM
 * @returns {string} - algorithm name used by the Web Crypto API
 */
function getWebDigestName(algorithm) {
	switch (algorithm.toLowerCase()) {
		case "sha1": {
			return "SHA-1";
		}
		case "sha256": {
			return "SHA-256";
		}
		default: {
			throw new Error(`unknown digest algorithm ${algorithm}`);
		}
	}
}

/**
 * Crypto operations needed for DKIM.
 *
 * Tries to be mostly just a wrapper around the Web Crypto API.
 */
export default class DkimCrypto {
	/**
	 * Generate a hash.
	 *
	 * @param {string} algorithm - sha1 / sha256
	 * @param {string} message - binary string
	 * @returns {Promise<string>} b64 encoded hash
	 */
	static async digest(algorithm, message) {
		const digest = await this.digestRaw(algorithm, message);
		return encodeBase64(digest);
	}

	/**
	 * Generate a hash.
	 *
	 * @param {string} algorithm - sha1 / sha256
	 * @param {string} message - binary string
	 * @returns {Promise<Uint8Array>} hash
	 */
	static async digestRaw(algorithm, message) {
		const digestName = getWebDigestName(algorithm);
		const data = strToArrayBuffer(message);
		const digest = await crypto.subtle.digest(digestName, data);
		const digestArray = new Uint8Array(digest);
		return digestArray;
	}

	/**
	 * Verify a signature.
	 *
	 * @param {string} signAlgorithm - rsa / ed25519
	 * @param {string} key - b64 encoded key
	 * @param {string} digestAlgorithm - sha1 / sha256
	 * @param {string} signature - b64 encoded signature
	 * @param {string} data - data whose signature is to be verified (binary string)
	 * @returns {Promise<[boolean, number]>} - valid, key length
	 * @throws {DKIM_SigError}
	 */
	static verify(signAlgorithm, key, digestAlgorithm, signature, data) {
		if (signAlgorithm === "rsa") {
			return this.verifyRSA(key, digestAlgorithm, signature, data);
		} else if (signAlgorithm === "ed25519") {
			return this.verifyEd25519(key, digestAlgorithm, signature, data);
		}
		throw new Error("Signing algorithm not implemented");
	}

	/**
	 * Verify an RSA signature.
	 *
	 * @param {string} key - b64 encoded RSA key in ASN.1 DER encoded SubjectPublicKeyInfo
	 * @param {string} digestAlgorithm - sha1 / sha256
	 * @param {string} signature - b64 encoded signature
	 * @param {string} data - data whose signature is to be verified (binary string)
	 * @returns {Promise<[boolean, number]>} - valid, key length
	 * @throws {DKIM_SigError}
	 */
	static async verifyRSA(key, digestAlgorithm, signature, data) {
		let cryptoKey;
		try {
			cryptoKey = await crypto.subtle.importKey(
				"spki",
				decodeBase64(key),
				{
					name: "RSASSA-PKCS1-v1_5",
					hash: getWebDigestName(digestAlgorithm),
				},
				true,
				["verify"]
			);
		} catch (error) {
			log.debug("error in importKey: ", error);
			throw new DKIM_SigError("DKIM_SIGERROR_KEYDECODE");
		}
		/** @type {RsaHashedKeyGenParams} */
		// @ts-expect-error
		const rsaKeyParams = cryptoKey.algorithm;
		try {
			const valid = await crypto.subtle.verify(
				"RSASSA-PKCS1-v1_5",
				cryptoKey,
				decodeBase64(signature),
				strToArrayBuffer(data)
			);
			return [valid, rsaKeyParams.modulusLength];
		} catch (error) {
			log.error("error in signature verification: ", error);
			return [false, rsaKeyParams.modulusLength];
		}
	}

	/**
	 * Verify an Ed25519 signature.
	 *
	 * @param {string} key - b64 encoded public key
	 * @param {string} digestAlgorithm - sha256
	 * @param {string} signature - b64 encoded signature
	 * @param {string} data - data whose signature is to be verified (binary string)
	 * @returns {Promise<[boolean, 256]>} - valid, key length
	 */
	static async verifyEd25519(key, digestAlgorithm, signature, data) {
		// Changed for Folder Filter Scheduler: WebCrypto Ed25519 replaces
		// tweetnacl. Thunderbird 147 and Node 22 both support it.
		const ed25519PublicKeyLenght = 256;
		let cryptoKey;
		try {
			cryptoKey = await crypto.subtle.importKey("raw", decodeBase64(key), { name: "Ed25519" }, false, ["verify"]);
		} catch (error) {
			log.debug("error in decoding key: ", error);
			throw new DKIM_SigError("DKIM_SIGERROR_KEYDECODE");
		}

		const hashValue = await this.digestRaw(digestAlgorithm, data);

		try {
			const valid = await crypto.subtle.verify("Ed25519", cryptoKey, decodeBase64(signature), hashValue);
			return [valid, ed25519PublicKeyLenght];
		} catch (error) {
			log.error("error in signature verification: ", error);
			return [false, ed25519PublicKeyLenght];
		}
	}
}
