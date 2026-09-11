/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Address-book helpers: pull email addresses out of contact vCards and out of
 * mailbox strings, normalised so the two can be compared.
 *
 * Pure and free of extension APIs, like matcher.js and domains.js. The
 * background script reads the address books and hands the resulting Sets to
 * the matcher; nothing here touches `messenger.*`.
 */

/** The sentinel address-book id meaning "every local address book". */
export const ALL_ADDRESS_BOOKS = 'all';

/** Fields an address-book condition may read: the ones that name a sender. */
export const ADDRESS_BOOK_FIELDS = Object.freeze(['from', 'reply-to', 'sender']);

/**
 * Normalise one address for comparison: the part inside <...> if present,
 * trimmed and lowercased. Returns null when there is no `local@domain` shape.
 * Lowercasing the local part is technically lossy, but every real provider
 * treats it case-insensitively and so do Thunderbird's own address-book lookups.
 */
export function normalizeAddress(address) {
  let candidate = String(address ?? '').trim();
  const angled = candidate.match(/<([^>]*)>/);
  if (angled) candidate = angled[1].trim();
  if (candidate.toLowerCase().startsWith('mailto:')) candidate = candidate.slice(7);
  candidate = candidate.toLowerCase();

  const at = candidate.lastIndexOf('@');
  if (at <= 0 || at === candidate.length - 1) return null;
  if (/\s/.test(candidate)) return null;
  return candidate;
}

/** Undo vCard line folding: a line starting with a space or tab continues the previous one. */
function unfold(vcard) {
  return String(vcard ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n[ \t]/g, '');
}

/**
 * Index of the colon that separates a vCard property's name and parameters
 * from its value. A parameter value may be quoted and contain a colon, so the
 * first colon is not always the right one.
 */
function valueSeparator(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) return i;
  }
  return -1;
}

/**
 * Every email address in one vCard string, normalised. Handles folded lines,
 * group prefixes (`item1.EMAIL`), parameters (`EMAIL;TYPE=work:`), and any
 * case. Anything that does not look like an address is skipped.
 */
export function emailsFromVCard(vcard) {
  const out = [];
  for (const line of unfold(vcard).split('\n')) {
    const sep = valueSeparator(line);
    if (sep === -1) continue;
    const name = line.slice(0, sep).split(';')[0].split('.').pop().trim().toUpperCase();
    if (name !== 'EMAIL') continue;
    const address = normalizeAddress(line.slice(sep + 1));
    if (address) out.push(address);
  }
  return out;
}

/** One Set of addresses from many vCards. */
export function addressSetFromVCards(vcards) {
  const set = new Set();
  for (const vcard of vcards ?? []) {
    for (const address of emailsFromVCard(vcard)) set.add(address);
  }
  return set;
}
