/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Translated text for every page and for the right-click menu.
 *
 * Every string a user sees lives in `_locales/<lang>/messages.json` and is
 * read through the WebExtension i18n API, which falls back to `en` for a key
 * the user's language does not define. Under plain Node, where `messenger` is
 * undefined, the English file is read from disk instead, so the pure modules
 * keep their English text in unit tests. See docs/TRANSLATING.md.
 */

let english = null;

/** The extension i18n API, looked up on each call so a test can stub it. */
const api = () => globalThis.messenger?.i18n ?? globalThis.browser?.i18n ?? null;

/** `_locales/en/messages.json`, for when the i18n API is not there. */
function englishMessages() {
  if (english) return english;
  english = {};
  try {
    const fs = globalThis.process?.getBuiltinModule?.('node:fs');
    if (fs) english = JSON.parse(fs.readFileSync(new URL('../_locales/en/messages.json', import.meta.url), 'utf8'));
  } catch {
    // No file means no fallback text; `t` then returns the key itself.
  }
  return english;
}

/**
 * The same substitution the WebExtension API does: named placeholders
 * (`$NAME$`) become their `content`, then `$1` to `$9` become the values and
 * `$$` becomes `$`. A missing value is empty, as in Thunderbird.
 */
function substitute(entry, values) {
  const named = Object.fromEntries(
    Object.entries(entry.placeholders ?? {}).map(([name, p]) => [name.toLowerCase(), p.content ?? '']),
  );
  const text = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (match, name) => named[name.toLowerCase()] ?? match);
  return text.replace(/\$(?:([1-9]\d*)|(\$+))/g, (match, index, dollars) =>
    index ? (values[Number(index) - 1] ?? '') : dollars.slice(1),
  );
}

/** The language of the Thunderbird interface, such as `de` or `pt-BR`. */
export function uiLanguage() {
  try {
    return api()?.getUILanguage?.() || 'en';
  } catch {
    return 'en';
  }
}

const formatters = new Map();
/** One cached Intl object per kind and language: building them is not free. */
function cached(kind, make) {
  const key = `${kind}|${uiLanguage()}`;
  if (!formatters.has(key)) {
    try {
      formatters.set(key, make(uiLanguage()));
    } catch {
      formatters.set(key, make('en'));
    }
  }
  return formatters.get(key);
}

/** Numbers in the user's format; everything else as text. */
function asText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return cached('number', (lang) => new Intl.NumberFormat(lang)).format(value);
  }
  return String(value ?? '');
}

/** The message, or '' when no locale defines the key. */
function lookup(key, values) {
  const strings = values.map(asText);
  const i18n = api();
  if (i18n?.getMessage) {
    try {
      return i18n.getMessage(key, strings) ?? '';
    } catch {
      return '';
    }
  }
  const entry = englishMessages()[key];
  return entry ? substitute(entry, strings) : '';
}

/**
 * The text for `key`, with `$1`, `$2`, and so on replaced by the values in
 * order. Returns the key itself when no locale defines it, so a missing key
 * shows up on the page instead of leaving a blank.
 */
export function t(key, ...substitutions) {
  return lookup(key, substitutions) || key;
}

/**
 * A message that changes with a number: `key_one`, `key_other`, and any
 * other CLDR category (`_zero`, `_two`, `_few`, `_many`) a language uses. The
 * category comes from `Intl.PluralRules` for the interface language. A
 * category the locale does not define falls back to `key_other`. The count is
 * not substituted on its own: pass it among the values where the text needs it.
 */
export function plural(key, count, ...substitutions) {
  const category = cached('plural', (lang) => new Intl.PluralRules(lang)).select(Number(count));
  return (category !== 'other' && lookup(`${key}_${category}`, substitutions)) || t(`${key}_other`, ...substitutions);
}

/**
 * Items joined the way the interface language joins a list: `conjunction`
 * ("a, b, and c"), `disjunction` ("a, b, or c"), or `unit` ("a, b, c").
 */
export function formatList(items, type = 'conjunction') {
  const style = type === 'unit' ? 'short' : 'long';
  return cached(`list-${type}`, (lang) => new Intl.ListFormat(lang, { type, style })).format(items.map(String));
}

// --- Messages with markup ----------------------------------------------------

/** The only tags a message may hold. Anything else is plain text. */
const RICH_TOKEN = /(<\/?(?:b|code|a)>|\d+)/;

/**
 * Split a message into text runs. A run is plain text, bold (`<b>`), code
 * (`<code>`), a link (`<a>`), or a slot (a control the page puts there). Tags
 * do not nest. Nothing here builds HTML, so a message can never inject markup.
 *
 * @returns {Array<{type: 'text'|'b'|'code'|'a', text: string} | {type: 'slot', index: number}>}
 */
export function parseRich(message) {
  const parts = [];
  let type = 'text';
  for (const token of String(message).split(RICH_TOKEN)) {
    if (token === '') continue;
    const tag = /^<(\/?)(b|code|a)>$/.exec(token);
    const slot = /^(\d+)$/.exec(token);
    if (tag) type = tag[1] ? 'text' : tag[2];
    else if (slot) parts.push({ type: 'slot', index: Number(slot[1]) });
    else parts.push({ type, text: token });
  }
  return parts;
}

/** The marker `setRich` hands to `t` for the slot at `index`. */
const slotMarker = (index) => `${index}`;

/**
 * Fill an element from a message with markup. The element's own form
 * controls and other child elements become `$1`, `$2`, and so on, in document
 * order, and keep their listeners. Each `<a>` in the message takes the next
 * `<a>` of the element, so the link target stays in the HTML. A control that
 * the message leaves out goes at the end rather than vanishing.
 */
function setRich(el, key) {
  const links = [...el.children].filter((c) => c.localName === 'a');
  const slots = [...el.children].filter((c) => !['a', 'b', 'code'].includes(c.localName));
  const used = new Set();
  const nodes = parseRich(t(key, ...slots.map((_, i) => slotMarker(i)))).map((part) => {
    if (part.type === 'slot') {
      used.add(part.index);
      return slots[part.index] ?? document.createTextNode('');
    }
    if (part.type === 'text') return document.createTextNode(part.text);
    const node = part.type === 'a' ? (links.shift()?.cloneNode(false) ?? document.createElement('span')) : document.createElement(part.type);
    node.textContent = part.text;
    return node;
  });
  el.replaceChildren(...nodes, ...slots.filter((_, i) => !used.has(i)));
}

/**
 * Plain text. An element with child elements, such as a label around a
 * checkbox, keeps them and gets the text after them.
 */
function setText(el, message) {
  if (el.children.length === 0) {
    el.textContent = message;
    return;
  }
  for (const node of [...el.childNodes]) if (node.nodeType === 3) node.remove();
  el.append(` ${message}`);
}

const ATTRIBUTES = { 'data-i18n-title': 'title', 'data-i18n-placeholder': 'placeholder', 'data-i18n-aria-label': 'aria-label' };

/** `root` and every element under it that carries `attribute`. */
function withAttribute(root, attribute) {
  const found = [...root.querySelectorAll(`[${attribute}]`)];
  return root.hasAttribute?.(attribute) ? [root, ...found] : found;
}

/**
 * Translate a page or part of one. The HTML keeps its English text, and the
 * attributes name the message that replaces it:
 *
 * - `data-i18n`: the text of the element.
 * - `data-i18n-rich`: text with `<b>`, `<code>`, `<a>`, and slots; see `setRich`.
 * - `data-i18n-title`, `data-i18n-placeholder`, `data-i18n-aria-label`: that attribute.
 *
 * The content of each `<template>` is translated too, so every clone of it
 * starts out translated.
 */
export function applyI18n(root = document) {
  for (const template of root.querySelectorAll('template')) applyI18n(template.content);
  for (const el of withAttribute(root, 'data-i18n')) setText(el, t(el.getAttribute('data-i18n')));
  for (const el of withAttribute(root, 'data-i18n-rich')) setRich(el, el.getAttribute('data-i18n-rich'));
  for (const [attribute, target] of Object.entries(ATTRIBUTES)) {
    for (const el of withAttribute(root, attribute)) el.setAttribute(target, t(el.getAttribute(attribute)));
  }
  if (root === document) document.documentElement.lang = uiLanguage();
}
