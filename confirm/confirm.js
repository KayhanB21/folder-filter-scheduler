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

function renderDomains(domains) {
  listEl.hidden = domains.length === 0;
  for (const domain of domains) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = true;
    box.value = domain;
    const text = document.createElement('span');
    text.textContent = domain;
    label.append(box, text);
    listEl.append(label);
  }
}

/** Explain a thin or empty result rather than appearing to have done nothing. */
function renderNotes() {
  const notes = [];
  if (payload.skippedAllowlisted.length > 0) {
    notes.push(
      `Skipped ${plural(payload.skippedAllowlisted.length, 'well-known provider domain')} ` +
        `(${payload.skippedAllowlisted.join(', ')}). These are never blocked, to protect ` +
        'legitimate mail.',
    );
  }
  if (payload.withoutHeader > 0) {
    notes.push(
      `${plural(payload.withoutHeader, 'message')} had no ${payload.field} header and ` +
        'contributed nothing. Matching uses that header, so those senders cannot be ' +
        'blocked this way.',
    );
  }
  if (payload.skippedInvalid.length > 0) {
    notes.push(`Ignored ${plural(payload.skippedInvalid.length, 'unreadable address')}.`);
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

  const { accepted, scanned } = payload;
  summaryEl.textContent =
    accepted.length > 0
      ? `Found ${plural(accepted.length, 'domain')} in ${plural(scanned, 'selected message')}. ` +
        `Checked domains will be added to the “${payload.ruleName}” rule, which moves ` +
        'matching mail to Trash on the normal schedule.'
      : `No new domains to add from ${plural(scanned, 'selected message')}.`;

  renderDomains(accepted);
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
