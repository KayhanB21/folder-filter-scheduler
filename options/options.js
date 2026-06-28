/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FIELDS } from '../src/matcher.js';

const $ = (sel, root = document) => root.querySelector(sel);
const rulesEl = $('#rules');
const statusEl = $('#status');

let folders = []; // [{ id, label }]

/** Build a flat, labelled folder list for the <select>s, across all accounts. */
async function loadFolders() {
  const accounts = await messenger.accounts.list();
  const nameByAccount = new Map(accounts.map((a) => [a.id, a.name]));
  const flat = [];

  // Preferred path: the flat folder query (Thunderbird 121+). One call, every folder.
  if (messenger.folders?.query) {
    try {
      const all = await messenger.folders.query({});
      for (const f of all) {
        if (!f.id || !f.path || f.path === '/') continue;
        flat.push({ id: f.id, label: `${nameByAccount.get(f.accountId) ?? ''}: ${f.path}` });
      }
      if (flat.length) {
        folders = flat;
        return;
      }
    } catch (e) {
      console.warn('[FolderFilterScheduler] folders.query failed, falling back', e);
    }
  }

  // Fallback: walk each account's tree, explicitly requesting subfolders.
  const withSubs = await messenger.accounts.list(true);
  const walk = (folder, accountName) => {
    if (folder.id && folder.path && folder.path !== '/') {
      flat.push({ id: folder.id, label: `${accountName}: ${folder.path}` });
    }
    for (const child of folder.subFolders ?? []) walk(child, accountName);
  };
  for (const account of withSubs) {
    walk(account.rootFolder ?? account, account.name);
  }
  folders = flat;
}

function fillFolderSelect(select, selectedIds = []) {
  select.innerHTML = '';
  for (const f of folders) {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.label;
    opt.selected = selectedIds.includes(f.id);
    select.append(opt);
  }
}

function fillFieldSelect(select, value) {
  select.innerHTML = '';
  for (const field of FIELDS) {
    const opt = document.createElement('option');
    opt.value = field;
    opt.textContent = field;
    opt.selected = field === value;
    select.append(opt);
  }
}

function renderCondition(container, cond = {}) {
  const node = $('#condition-template').content.firstElementChild.cloneNode(true);
  fillFieldSelect($('.cond-field', node), cond.field ?? 'reply-to');
  $('.cond-op', node).value = cond.operator ?? 'contains';
  $('.cond-negate', node).checked = !!cond.negate;
  $('.cond-value', node).value = cond.value ?? '';
  $('.del-cond', node).addEventListener('click', () => node.remove());
  container.append(node);
}

function renderRule(rule = {}) {
  const node = $('#rule-template').content.firstElementChild.cloneNode(true);
  $('.rule-name', node).value = rule.name ?? 'New rule';
  $('.rule-enabled', node).checked = rule.enabled !== false;
  $('.rule-match', node).value = rule.match ?? 'any';
  fillFolderSelect($('.rule-folders', node), rule.folderIds ?? []);

  const condContainer = $('.conditions', node);
  const conds = rule.conditions?.length ? rule.conditions : [{}];
  for (const c of conds) renderCondition(condContainer, c);
  $('.add-cond', node).addEventListener('click', () => renderCondition(condContainer, {}));

  const actionType = $('.rule-action-type', node);
  const actionFolder = $('.rule-action-folder', node);
  fillFolderSelect(actionFolder, rule.action?.folderId ? [rule.action.folderId] : []);
  const syncActionFolder = () => {
    const needsFolder = actionType.value === 'move' || actionType.value === 'copy';
    actionFolder.classList.toggle('hidden', !needsFolder);
  };
  actionType.value = rule.action?.type ?? 'trash';
  actionType.addEventListener('change', syncActionFolder);
  syncActionFolder();

  $('.del-rule', node).addEventListener('click', () => node.remove());
  rulesEl.append(node);
}

/** Read the DOM back into a config object. */
function collectConfig() {
  const rules = [...rulesEl.querySelectorAll('.rule')].map((node) => {
    const actionType = $('.rule-action-type', node).value;
    const action = { type: actionType };
    if (actionType === 'move' || actionType === 'copy') {
      action.folderId = $('.rule-action-folder', node).value;
    }
    return {
      name: $('.rule-name', node).value.trim() || 'Untitled rule',
      enabled: $('.rule-enabled', node).checked,
      match: $('.rule-match', node).value,
      folderIds: [...$('.rule-folders', node).selectedOptions].map((o) => o.value),
      conditions: [...node.querySelectorAll('.condition')].map((c) => ({
        field: $('.cond-field', c).value,
        operator: $('.cond-op', c).value,
        value: $('.cond-value', c).value,
        negate: $('.cond-negate', c).checked,
      })),
      action,
    };
  });
  return { intervalMinutes: Math.max(1, Number($('#interval').value) || 10), rules };
}

function flash(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? 'var(--danger)' : 'var(--accent)';
}

async function save() {
  const config = collectConfig();
  await messenger.storage.local.set({ config });
  await messenger.runtime.sendMessage({ command: 'reschedule' });
  flash('Saved. Schedule updated.');
}

async function runNow() {
  flash('Running…');
  try {
    const res = await messenger.runtime.sendMessage({ command: 'runNow' });
    flash(`Done — ${res?.affected ?? 0} message(s) affected.`);
  } catch (e) {
    flash(`Run failed: ${e.message}`, true);
  }
}

async function init() {
  await loadFolders();
  const { config } = await messenger.storage.local.get({ config: null });
  $('#interval').value = config?.intervalMinutes ?? 10;
  const rules = config?.rules?.length ? config.rules : [{}];
  for (const r of rules) renderRule(r);

  $('#add-rule').addEventListener('click', () => renderRule({}));
  $('#save').addEventListener('click', () => save().catch((e) => flash(e.message, true)));
  $('#run-now').addEventListener('click', runNow);

  if (folders.length === 0) {
    flash('No folders found — check the “accountsRead” permission and reload the add-on.', true);
  }
}

init().catch((e) => flash(e.message, true));
