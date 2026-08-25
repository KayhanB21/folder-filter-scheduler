/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sender-domain extraction, validation, and list matching.
 *
 * Like matcher.js this module is pure and has ZERO dependency on the
 * WebExtension / Thunderbird APIs, so it is unit-testable under plain Node.
 * The background script parses addresses with `messengerUtilities` where it
 * can and feeds the results here; every function below also copes with a raw
 * mailbox string ("Bella" <bella@example.org>) so matching at scan time works
 * straight off a header value.
 */

/**
 * Providers whose domains must never be blocklisted wholesale. Blocking one of
 * these would silently discard mail from a large fraction of legitimate
 * senders, so a harvested domain matching this list is dropped rather than
 * offered to the user.
 */
export const DEFAULT_ALLOWLIST = Object.freeze([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.net',
  'web.de',
  'mail.ru',
  'yandex.ru',
  'zoho.com',
  'fastmail.com',
  'tutanota.com',
  'tuta.com',
]);

/** Lowercase, trim, and drop a single trailing dot (the FQDN root form). */
export function normalizeDomain(domain) {
  return String(domain ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

/**
 * Whether a string is a plausible DNS domain we are willing to block on.
 *
 * This is the guard that keeps a blank or malformed entry out of a blocklist.
 * An empty needle would otherwise match every message, and a rule whose action
 * deletes would then empty the folder on the next scheduled tick.
 */
export function isValidDomain(domain) {
  const d = normalizeDomain(domain);
  if (!d || d.length > 253) return false;
  if (!d.includes('.')) return false;
  if (d.startsWith('.') || d.endsWith('.') || d.includes('..')) return false;

  const labels = d.split('.');
  for (const label of labels) {
    if (!label || label.length > 63) return false;
    if (!/^[a-z0-9-]+$/.test(label)) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
  }

  // Require a real TLD: letters only, or an IDN a-label. Rejects bare IPs too.
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,}$/.test(tld) || tld.startsWith('xn--');
}

/**
 * Split a header value into individual addresses.
 *
 * A single To/Reply-To header may legally carry several comma-separated
 * mailboxes, and a display name may itself contain a comma inside quotes, so a
 * naive split() is wrong. Tracks quoting and angle brackets instead.
 */
export function addressesFromHeaderValue(value) {
  const out = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;

  for (const ch of String(value ?? '')) {
    if (ch === '"' && !inAngle) inQuotes = !inQuotes;
    else if (ch === '<' && !inQuotes) inAngle = true;
    else if (ch === '>' && !inQuotes) inAngle = false;
    else if (ch === ',' && !inQuotes && !inAngle) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);

  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Pull the domain out of one address, which may be bare (`a@b.com`) or a full
 * mailbox string (`"Name" <a@b.com>`). Returns null when there is no usable,
 * valid domain — callers treat null as "nothing to harvest here".
 */
export function domainFromAddress(address) {
  let candidate = String(address ?? '').trim();

  const angled = candidate.match(/<([^>]*)>/);
  if (angled) candidate = angled[1].trim();

  const at = candidate.lastIndexOf('@');
  if (at === -1) return null;

  const domain = normalizeDomain(candidate.slice(at + 1));
  return isValidDomain(domain) ? domain : null;
}

/** Every distinct valid domain named by one raw header value. */
export function domainsFromHeaderValue(value) {
  const seen = new Set();
  for (const address of addressesFromHeaderValue(value)) {
    const domain = domainFromAddress(address);
    if (domain) seen.add(domain);
  }
  return [...seen];
}

/** True when `domain` is, or is a subdomain of, an allowlisted provider. */
export function isAllowlisted(domain, allowlist = DEFAULT_ALLOWLIST) {
  const d = normalizeDomain(domain);
  if (!d) return false;
  return (allowlist ?? []).some((entry) => {
    const e = normalizeDomain(entry);
    return Boolean(e) && (d === e || d.endsWith(`.${e}`));
  });
}

/**
 * True when `domain` is in `domains`, or is a subdomain of an entry.
 *
 * Subdomains count because that is how bulk senders actually send: blocking
 * evil.com is expected to stop bounce.evil.com as well. Walks the candidate's
 * own suffixes so the cost is the label count, not the size of the list.
 *
 * An empty list never matches. That invariant is what keeps a blank blocklist
 * from swallowing an entire folder.
 */
export function matchesDomainList(domain, domains) {
  const d = normalizeDomain(domain);
  if (!d) return false;

  const list = domains instanceof Set ? domains : new Set((domains ?? []).map(normalizeDomain));
  if (list.size === 0) return false;
  if (list.has(d)) return true;

  // Suffixes with at least two labels: evil.com counts, the bare TLD never does.
  const labels = d.split('.');
  for (let i = 1; i < labels.length - 1; i += 1) {
    if (list.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

/**
 * Vet a batch of harvested addresses.
 *
 * Returns the domains worth offering to the user plus the two reasons a domain
 * was withheld, so the confirmation dialog can explain an empty result instead
 * of appearing to do nothing.
 */
export function harvestDomains(addresses, allowlist = DEFAULT_ALLOWLIST) {
  const accepted = [];
  const skippedAllowlisted = [];
  const skippedInvalid = [];
  const seen = new Set();

  for (const address of addresses ?? []) {
    const domain = domainFromAddress(address);
    if (!domain) {
      const raw = String(address ?? '').trim();
      if (raw && !skippedInvalid.includes(raw)) skippedInvalid.push(raw);
      continue;
    }
    if (seen.has(domain)) continue;
    seen.add(domain);

    if (isAllowlisted(domain, allowlist)) skippedAllowlisted.push(domain);
    else accepted.push(domain);
  }

  return { accepted, skippedAllowlisted, skippedInvalid };
}

/**
 * Parse a newline-separated textarea into a clean domain list. Used by the
 * options page, which must never write an invalid entry into a rule.
 */
export function parseDomainList(text) {
  const domains = [];
  const invalid = [];
  const seen = new Set();

  for (const rawLine of String(text ?? '').split(/[\r\n,]+/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // Tolerate a pasted address or a leading "@" — take the domain part.
    const domain = line.includes('@') ? domainFromAddress(line) : normalizeDomain(line);
    if (!domain || !isValidDomain(domain)) {
      invalid.push(line);
      continue;
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }

  domains.sort();
  return { domains, invalid };
}

/** Merge new domains into an existing list, returning the union and what was new. */
export function mergeDomainLists(existing, incoming) {
  const seen = new Set((existing ?? []).map(normalizeDomain).filter(Boolean));
  const added = [];

  for (const domain of incoming ?? []) {
    const d = normalizeDomain(domain);
    if (!d || !isValidDomain(d) || seen.has(d)) continue;
    seen.add(d);
    added.push(d);
  }

  return { domains: [...seen].sort(), added };
}
