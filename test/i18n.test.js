/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { formatList, parseRich, plural, t } from '../src/i18n.js';
import { FIELDS, STATE_FIELDS, STATE_OPERATORS } from '../src/matcher.js';
import { ADDRESS_BOOK_FIELDS } from '../src/contacts.js';
import { ACTIONS } from '../src/actions.js';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const LOCALES = readdirSync(new URL('_locales/', root));
const catalog = (locale) => JSON.parse(read(`_locales/${locale}/messages.json`));
const en = catalog('en');

/** A plural variant a language can add although English has no such key. */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const englishFor = (key) => en[key] ?? (PLURAL_SUFFIX.test(key) ? en[key.replace(PLURAL_SUFFIX, '_other')] : undefined);

/** `$1`, `$2`, ... and named `$NAME$` placeholders, in a sorted list. */
const placeholdersOf = (message) => [...new Set(message.match(/\$(?:[1-9]|[A-Za-z0-9_@]+\$)/g) ?? [])].map((p) => p.toLowerCase()).sort();
const tagsOf = (message) => (message.match(/<\/?(?:b|code|a)>/g) ?? []).sort();

const SOURCES = ['options/options.js', 'popup/popup.js', 'confirm/confirm.js', ...readdirSync(new URL('src/', root))
  .filter((f) => f.endsWith('.js'))
  .map((f) => `src/${f}`)];
const PAGES = ['options/options.html', 'popup/popup.html', 'confirm/confirm.html'];

/** Every key the pages name through a `data-i18n*` attribute. */
function pageKeys() {
  return PAGES.flatMap((page) => [...read(page).matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((m) => [page, m[1]]));
}

/**
 * Every key the code names: the first argument of `t('...')` and
 * `plural('...')`, and any other quoted word that looks like a key, which
 * catches keys picked in a ternary or kept in a table.
 */
function codeKeys() {
  const prefixes = new Set(Object.keys(en).map((key) => key.split('_')[0]).filter((p) => !/^extension/.test(p)));
  return SOURCES.flatMap((file) =>
    [...read(file).matchAll(/'([a-z]+_[A-Za-z0-9_]+)'/g)]
      .filter((m) => prefixes.has(m[1].split('_')[0]))
      .map((m) => [file, m[1]]),
  );
}

test('every locale file parses and every entry has a message', () => {
  assert.ok(LOCALES.includes('en'));
  for (const locale of LOCALES) {
    const messages = catalog(locale);
    for (const [key, entry] of Object.entries(messages)) {
      assert.match(key, /^[A-Za-z0-9_@]+$/, `${locale}: ${key} is not a valid message name`);
      assert.equal(typeof entry.message, 'string', `${locale}: ${key}`);
    }
    assert.ok(messages.extensionName && messages.extensionDescription, locale);
  }
});

test('every English message tells the translator its context', () => {
  for (const [key, entry] of Object.entries(en)) {
    assert.ok(typeof entry.description === 'string' && entry.description.length > 0, key);
  }
});

test('every key in a translation exists in English', () => {
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    for (const key of Object.keys(catalog(locale))) {
      assert.ok(englishFor(key), `${locale}: ${key} is not in en`);
    }
  }
});

test('a translation keeps every placeholder and tag of the English message', () => {
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    for (const [key, entry] of Object.entries(catalog(locale))) {
      const source = englishFor(key);
      if (!source) continue;
      assert.deepEqual(placeholdersOf(entry.message), placeholdersOf(source.message), `${locale}: ${key} placeholders`);
      assert.deepEqual(tagsOf(entry.message), tagsOf(source.message), `${locale}: ${key} markup`);
      for (const name of Object.keys(source.placeholders ?? {})) {
        assert.ok(entry.placeholders?.[name], `${locale}: ${key} must define the placeholder ${name}`);
      }
    }
  }
});

test('every key the pages and the code name exists in English', () => {
  const exists = (key) => en[key] || (en[`${key}_one`] && en[`${key}_other`]);
  for (const [file, key] of [...pageKeys(), ...codeKeys()]) {
    assert.ok(exists(key), `${file}: ${key} is not in _locales/en/messages.json`);
  }
  assert.ok(pageKeys().length > 50 && codeKeys().length > 100, 'the key scan found too few keys');
});

test('every plural message has both an English _one and _other form', () => {
  for (const key of Object.keys(en).filter((k) => PLURAL_SUFFIX.test(k))) {
    const base = key.replace(PLURAL_SUFFIX, '');
    assert.ok(en[`${base}_one`] && en[`${base}_other`], base);
  }
});

test('the keys built at run time exist in English', () => {
  // options.js names a field by `field_` plus its value, "-" read as "_".
  for (const field of new Set([...FIELDS, ...ADDRESS_BOOK_FIELDS])) {
    assert.ok(en[`field_${field.replace(/-/g, '_')}`], field);
  }
  for (const field of STATE_FIELDS) {
    for (const operator of Object.keys(STATE_OPERATORS)) assert.ok(en[`state_${field}_${operator}`], `${field} ${operator}`);
  }
  for (const def of ACTIONS) {
    assert.notEqual(def.label, `action_${def.id}`, def.id);
    assert.notEqual(def.hint, `action_${def.id}Hint`, def.id);
  }
});

test('without the i18n API, t reads the English file and fills in the values', () => {
  assert.equal(t('extensionName'), 'Folder Filter Scheduler');
  assert.equal(t('status_runningRule', 'Banks'), 'Running “Banks”…');
  assert.equal(t('cron_errorOutOfRange', 'Minute', 0, 59, 60), 'Minute must be from 0 to 59, got 60');
  assert.equal(t('no_such_key'), 'no_such_key');
});

test('plural picks the form for the count', () => {
  assert.equal(plural('popup_runDone', 1, 1), 'Done. 1 message affected.');
  assert.equal(plural('popup_runDone', 0, 0), 'Done. 0 messages affected.');
  assert.equal(plural('popup_runDone', 2, 2), 'Done. 2 messages affected.');
});

test('with the i18n API, a missing plural form falls back to _other', () => {
  const calls = [];
  globalThis.messenger = {
    i18n: {
      getUILanguage: () => 'pl',
      // Polish uses "few" for 2, which this catalog does not define.
      getMessage: (key, values) => {
        calls.push(key);
        return { x_one: 'one $1', x_other: 'other $1' }[key]?.replace('$1', values[0]) ?? '';
      },
    },
  };
  try {
    assert.equal(plural('x', 2, 2), 'other 2');
    assert.deepEqual(calls, ['x_few', 'x_other']);
    assert.equal(plural('x', 1, 1), 'one 1');
    assert.equal(t('missing'), 'missing');
  } finally {
    delete globalThis.messenger;
  }
});

test('formatList joins the way the language does', () => {
  assert.equal(formatList(['a', 'b', 'c']), 'a, b, and c');
  assert.equal(formatList(['a', 'b'], 'disjunction'), 'a or b');
  assert.equal(formatList(['a', 'b', 'c'], 'unit'), 'a, b, c');
});

test('parseRich allows only b, code, a, and slots, and never builds markup', () => {
  assert.deepEqual(parseRich('Select <b>Save</b> to apply.'), [
    { type: 'text', text: 'Select ' },
    { type: 'b', text: 'Save' },
    { type: 'text', text: ' to apply.' },
  ]);
  assert.deepEqual(parseRich('Run every 0 minutes, see <a>help</a>'), [
    { type: 'text', text: 'Run every ' },
    { type: 'slot', index: 0 },
    { type: 'text', text: ' minutes, see ' },
    { type: 'a', text: 'help' },
  ]);
  // Anything else stays text, so an address in angle brackets is safe.
  assert.deepEqual(parseRich('<code>Lena <lena@yahoo.com></code> <img src=x onerror=alert(1)>'), [
    { type: 'code', text: 'Lena <lena@yahoo.com>' },
    { type: 'text', text: ' <img src=x onerror=alert(1)>' },
  ]);
});
