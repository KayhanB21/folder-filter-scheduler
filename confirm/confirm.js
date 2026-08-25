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

const $ = (sel) => document.querySelector(sel);
const summaryEl = $('#summary');
const listEl = $('#domain-list');
const notesEl = $('#notes');
const addButton = $('#add');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

let payload = null;

const FIELD_LABELS = {
  'reply-to': {
    title: 'Reply-To domains',
    note: 'Where replies would go. Harder to forge on bulk mail.',
  },
  from: {
    title: 'From domains',
    note: 'The visible sender, which can be forged to impersonate a brand. Check these before adding.',
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
    notes.push(
      `Skipped ${plural(allowlisted.length, 'well-known provider domain')} ` +
        `(${allowlisted.join(', ')}). These are never blocked, to protect legitimate mail.`,
    );
  }
  if (payload.unreadable > 0) {
    notes.push(`${plural(payload.unreadable, 'message')} could not be read.`);
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
    summaryEl.textContent = 'This confirmation has expired. Please run the action again.';
    return;
  }

  const total = payload.groups.reduce((n, g) => n + g.accepted.length, 0);
  summaryEl.textContent =
    total > 0
      ? `Found ${plural(total, 'domain')} in ${plural(payload.scanned, 'selected message')}. ` +
        `Checked domains will be added to the “${payload.ruleName}” rule, which moves ` +
        'matching mail to Trash on the normal schedule.'
      : `No new domains to add from ${plural(payload.scanned, 'selected message')}.`;

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
    summaryEl.textContent = `Could not update the filter: ${e.message}`;
    addButton.disabled = false;
  }
});

load().catch((e) => {
  summaryEl.textContent = `Could not read the selection: ${e.message}`;
});
