/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Confirmation step for a right-click domain harvest.
 *
 * Nothing is written to a filter until the user presses Add here, so a
 * mis-selected message cannot quietly start deleting mail. The payload is
 * handed over by the background script through storage rather than the URL,
 * because a long domain list does not belong in a query string.
 */

import { applyI18n, formatList, plural, t } from '../src/i18n.js';

applyI18n();

const $ = (sel) => document.querySelector(sel);
const summaryEl = $('#summary');
const listEl = $('#domain-list');
const notesEl = $('#notes');
const addButton = $('#add');

let payload = null;

const FIELD_LABELS = {
  'reply-to': {
    get title() { return t('confirm_replyToTitle'); },
    get note() { return t('confirm_replyToNote'); },
  },
  from: {
    get title() { return t('confirm_fromTitle'); },
    get note() { return t('confirm_fromNote'); },
  },
};

/** One checkbox group per source header, so From domains can be vetted apart. */
function renderGroup(group) {
  if (group.accepted.length === 0) return;
  const meta = FIELD_LABELS[group.field] ?? { title: group.field, note: '' };

  const section = document.createElement('section');
  section.className = 'domain-group';

  const heading = document.createElement('h2');
  heading.textContent = meta.title;
  const note = document.createElement('p');
  note.className = 'group-note';
  note.textContent = meta.note;
  section.append(heading, note);

  const list = document.createElement('div');
  list.className = 'domain-list';
  for (const domain of group.accepted) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.value = domain;
    const text = document.createElement('span');
    text.textContent = domain;
    label.append(box, text);
    list.append(label);
  }
  section.append(list);
  listEl.append(section);
}

/** Explain a thin or empty result rather than appearing to have done nothing. */
function renderNotes() {
  const notes = [];
  const allowlisted = [...new Set(payload.groups.flatMap((g) => g.skippedAllowlisted))];
  if (allowlisted.length > 0) {
    notes.push(plural('confirm_skippedProviders', allowlisted.length, allowlisted.length, formatList(allowlisted, 'unit')));
  }
  if (payload.unreadable > 0) {
    notes.push(plural('confirm_unreadable', payload.unreadable, payload.unreadable));
  }
  notesEl.textContent = notes.join(' ');
}

function selectedDomains() {
  return [...listEl.querySelectorAll('input:checked')].map((b) => b.value);
}

function syncAddButton() {
  addButton.disabled = selectedDomains().length === 0;
}

async function load() {
  const token = new URLSearchParams(location.search).get('token');
  const res = await messenger.runtime.sendMessage({ command: 'harvestPayload', token });
  payload = res?.payload;

  if (!payload) {
    summaryEl.textContent = t('confirm_expired');
    return;
  }

  const total = payload.groups.reduce((n, g) => n + g.accepted.length, 0);
  const messages = plural('confirm_selectedMessages', payload.scanned, payload.scanned);
  summaryEl.textContent =
    total > 0
      ? t('confirm_found', plural('confirm_domains', total, total), messages, payload.ruleName)
      : t('confirm_noneNew', messages);

  listEl.hidden = total === 0;
  for (const group of payload.groups) renderGroup(group);
  renderNotes();
  syncAddButton();
  listEl.addEventListener('change', syncAddButton);
}

$('#cancel').addEventListener('click', () => window.close());

$('#add').addEventListener('click', async () => {
  addButton.disabled = true;
  try {
    await messenger.runtime.sendMessage({
      command: 'harvestConfirm',
      domains: selectedDomains(),
      folderId: payload?.folderId ?? null,
      skipNextTime: $('#skip-next-time').checked,
    });
    window.close();
  } catch (e) {
    summaryEl.textContent = t('confirm_updateFailed', e.message);
    addButton.disabled = false;
  }
});

load().catch((e) => {
  summaryEl.textContent = t('confirm_readFailed', e.message);
});
