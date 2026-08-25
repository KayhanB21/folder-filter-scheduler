/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FIELDS, DOMAIN_IN_LIST } from '../src/matcher.js';
import { ACTIONS, ACTIONS_BY_ID } from '../src/actions.js';
import { DEFAULT_ALLOWLIST, parseDomainList } from '../src/domains.js';
import { buildExport, exportFilename, sanitizeImport } from '../src/rules.js';

const $ = (sel, root = document) => root.querySelector(sel);
const rulesEl = $('#rules');
const statusEl = $('#status');

let folders = []; // [{ id, label }]

/**
 * Which rules are collapsed. This is a view preference only: it lives in
 * localStorage, never in the stored config, so collapsing a rule cannot change
 * what is saved or exported.
 */
const COLLAPSED_KEY = 'ffs.collapsedRules';

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]));
  } catch {
    // A missing localStorage only costs the preference, never the rules.
  }
}

let collapsed = loadCollapsed();

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

/** A domain-list condition can watch several headers at once. */
const DOMAIN_FIELD_SETS = [
  { value: 'reply-to,from', label: 'reply-to or from' },
  { value: 'reply-to', label: 'reply-to' },
  { value: 'from', label: 'from' },
];

function fillDomainFieldSelect(select, cond) {
  const current = (cond.fields ?? [cond.field ?? 'reply-to']).join(',');
  select.innerHTML = '';
  for (const set of DOMAIN_FIELD_SETS) {
    const opt = document.createElement('option');
    opt.value = set.value;
    opt.textContent = set.label;
    opt.selected = set.value === current;
    select.append(opt);
  }
  if (!DOMAIN_FIELD_SETS.some((s) => s.value === current)) select.value = 'reply-to,from';
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
  const op = $('.cond-op', node);
  op.value = cond.operator ?? 'contains';
  $('.cond-negate', node).checked = !!cond.negate;
  $('.cond-value', node).value = cond.value ?? '';
  $('.cond-domains', node).value = (cond.domains ?? []).join('\n');

  // A domain list needs a textarea, not a one-line input: a harvested list runs
  // to hundreds of entries and would otherwise be unreadable and uneditable.
  const fieldSelect = $('.cond-field', node);
  const syncOperator = () => {
    const isList = op.value === DOMAIN_IN_LIST;
    $('.cond-domains', node).classList.toggle('hidden', !isList);
    $('.cond-value', node).classList.toggle('hidden', isList);
    if (isList) fillDomainFieldSelect(fieldSelect, cond);
    else fillFieldSelect(fieldSelect, cond.field ?? 'reply-to');
  };
  op.addEventListener('change', syncOperator);
  syncOperator();

  $('.del-cond', node).addEventListener('click', () => node.remove());
  container.append(node);
}

function renderRule(rule = {}) {
  const node = $('#rule-template').content.firstElementChild.cloneNode(true);
  $('.rule-id', node).value = rule.id ?? crypto.randomUUID();
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
  const actionHint = $('.action-hint', node);

  // Populate the action dropdown from the registry — UI stays in lockstep with the engine.
  for (const def of ACTIONS) {
    const opt = document.createElement('option');
    opt.value = def.id;
    opt.textContent = def.label;
    actionType.append(opt);
  }
  fillFolderSelect(actionFolder, rule.action?.folderId ? [rule.action.folderId] : []);

  const syncAction = () => {
    const def = ACTIONS_BY_ID[actionType.value];
    actionFolder.classList.toggle('hidden', !def?.needsFolder);
    actionHint.textContent = def?.hint ?? '';
    actionHint.classList.toggle('danger', !!def?.danger);
  };
  actionType.value = rule.action?.type ?? 'trash';
  actionType.addEventListener('change', syncAction);
  syncAction();

  $('.del-rule', node).addEventListener('click', () => {
    collapsed.delete($('.rule-id', node).value);
    saveCollapsed(collapsed);
    node.remove();
  });

  const collapseButton = $('.rule-collapse', node);
  collapseButton.addEventListener('click', () =>
    setCollapsed(node, !node.classList.contains('collapsed')),
  );

  rulesEl.append(node);
  // Restore the remembered view state. A rule the user just added stays open.
  if (rule.id && collapsed.has(rule.id)) setCollapsed(node, true);
}

/** A one-line digest of a rule, shown while it is collapsed. */
function ruleSummary(node) {
  const conditions = [...node.querySelectorAll('.condition')].map((c) => {
    // A multi-field set is stored comma-joined; read it back as prose.
    const field = $('.cond-field', c).value.split(',').join(' or ');
    const negate = $('.cond-negate', c).checked ? 'not ' : '';
    if ($('.cond-op', c).value === DOMAIN_IN_LIST) {
      const { domains } = parseDomainList($('.cond-domains', c).value);
      return `${field} ${negate}in list of ${domains.length}`;
    }
    return `${field} ${negate}${$('.cond-op', c).value} “${$('.cond-value', c).value}”`;
  });

  const joiner = $('.rule-match', node).value === 'all' ? ' AND ' : ' OR ';
  const action = ACTIONS_BY_ID[$('.rule-action-type', node).value]?.label ?? 'no action';
  const folderCount = $('.rule-folders', node).selectedOptions.length;
  const where = `${folderCount} folder${folderCount === 1 ? '' : 's'}`;
  const what = conditions.join(joiner) || 'no conditions';

  return `${what} → ${action} · ${where}`;
}

function setCollapsed(node, isCollapsed) {
  const id = $('.rule-id', node).value;
  node.classList.toggle('collapsed', isCollapsed);
  $('.rule-collapse', node).textContent = isCollapsed ? '▸' : '▾';
  $('.rule-collapse', node).setAttribute('aria-expanded', String(!isCollapsed));
  if (isCollapsed) {
    $('.rule-summary', node).textContent = ruleSummary(node);
    collapsed.add(id);
  } else {
    collapsed.delete(id);
  }
  saveCollapsed(collapsed);
}

function setAllCollapsed(isCollapsed) {
  for (const node of rulesEl.querySelectorAll('.rule')) setCollapsed(node, isCollapsed);
  $('#toggle-all').textContent = isCollapsed ? 'Expand all' : 'Collapse all';
}

/** Read the DOM back into a config object. */
function collectConfig(rejected = []) {
  const rules = [...rulesEl.querySelectorAll('.rule')].map((node) => {
    const actionType = $('.rule-action-type', node).value;
    const action = { type: actionType };
    if (actionType === 'move' || actionType === 'copy') {
      action.folderId = $('.rule-action-folder', node).value;
    }
    return {
      id: $('.rule-id', node).value || crypto.randomUUID(),
      name: $('.rule-name', node).value.trim() || 'Untitled rule',
      enabled: $('.rule-enabled', node).checked,
      match: $('.rule-match', node).value,
      folderIds: [...$('.rule-folders', node).selectedOptions].map((o) => o.value),
      conditions: [...node.querySelectorAll('.condition')].map((c) => {
        const operator = $('.cond-op', c).value;
        const condition = {
          field: $('.cond-field', c).value,
          operator,
          negate: $('.cond-negate', c).checked,
        };
        if (operator === DOMAIN_IN_LIST) {
          condition.fields = $('.cond-field', c).value.split(',');
          delete condition.field;
          // parseDomainList drops anything malformed, so a stray blank line can
          // never become an entry that matches every message.
          const { domains, invalid } = parseDomainList($('.cond-domains', c).value);
          condition.domains = domains;
          rejected.push(...invalid);
        } else {
          condition.value = $('.cond-value', c).value;
        }
        return condition;
      }),
      action,
    };
  });

  const { domains: allowlist } = parseDomainList($('#allowlist').value);
  return {
    intervalMinutes: Math.max(1, Number($('#interval').value) || 10),
    rules,
    allowlist,
  };
}

function flash(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? 'var(--danger)' : 'var(--accent)';
}

async function save() {
  const rejected = [];
  const collected = collectConfig(rejected);
  // Merge, so keys the options page does not own (harvestRuleId,
  // skipHarvestConfirm) survive a save.
  const { config: stored } = await messenger.storage.local.get({ config: null });
  await messenger.storage.local.set({ config: { ...stored, ...collected } });
  await messenger.runtime.sendMessage({ command: 'reschedule' });

  // Re-render so the user sees exactly what was stored, dropped lines included.
  rulesEl.innerHTML = '';
  for (const rule of collected.rules) renderRule(rule);
  $('#allowlist').value = collected.allowlist.join('\n');

  flash(
    rejected.length > 0
      ? `Saved. Ignored ${rejected.length} unusable entr${rejected.length === 1 ? 'y' : 'ies'}: ${rejected.join(', ')}`
      : 'Saved. Schedule updated.',
  );
}

function exportRules() {
  const now = new Date();
  const blob = new Blob([JSON.stringify(buildExport(collectConfig(), { exportedAt: now }), null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFilename(now);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  flash(`Exported to ${exportFilename(now)}. Unsaved edits on this page are included.`);
}

/**
 * Import is deliberately staged: rules are validated and rendered into the page,
 * but nothing is stored until the user presses Save. So a bad file can be
 * abandoned by reloading, and can never start deleting mail on its own.
 */
async function importRules(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    flash(`Could not read ${file.name}: ${e.message}`, true);
    return;
  }

  const { rules, duplicates, allowlist, intervalMinutes, problems } = sanitizeImport(data, {
    knownFolderIds: folders.map((f) => f.id),
    // Compare against what is on the page, including unsaved edits, so
    // re-importing the same file does not pile up duplicate rules.
    existingRules: collectConfig().rules,
  });

  const dupeNote = duplicates.length
    ? ` Already present, skipped: ${duplicates
        .map((d) => `“${d.name}” (${d.hash}, same as “${d.matches}”)`)
        .join(', ')}.`
    : '';

  if (rules.length === 0) {
    const why = problems.join('; ') || (duplicates.length ? '' : 'The file contained no usable rules.');
    flash(`Nothing new to import.${why ? ` ${why}.` : ''}${dupeNote}`, !duplicates.length);
    return;
  }

  for (const rule of rules) renderRule(rule);
  if (allowlist?.length) $('#allowlist').value = allowlist.join('\n');
  if (intervalMinutes) $('#interval').value = intervalMinutes;

  const skipped = problems.length > 0 ? ` Skipped: ${problems.join('; ')}.` : '';
  flash(
    `Imported ${rules.length} rule(s) — review them, then press Save to keep them.${skipped}${dupeNote}`,
    problems.length > 0,
  );
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

  // On a first visit with many rules, start collapsed: a folder multi-select
  // makes each card tall enough that a dozen rules cannot be scanned otherwise.
  const firstVisit = localStorage.getItem(COLLAPSED_KEY) === null;
  for (const r of rules) renderRule(r);
  if (firstVisit && rules.length > 3) setAllCollapsed(true);

  $('#allowlist').value = (config?.allowlist ?? DEFAULT_ALLOWLIST).join('\n');
  $('#reset-allowlist').addEventListener('click', () => {
    $('#allowlist').value = [...DEFAULT_ALLOWLIST].join('\n');
    flash('Protected domains restored to defaults. Press Save to keep them.');
  });

  $('#add-rule').addEventListener('click', () => renderRule({}));
  $('#toggle-all').addEventListener('click', () =>
    setAllCollapsed($('#toggle-all').textContent === 'Collapse all'),
  );
  $('#save').addEventListener('click', () => save().catch((e) => flash(e.message, true)));
  $('#run-now').addEventListener('click', runNow);
  $('#export').addEventListener('click', () => {
    try {
      exportRules();
    } catch (e) {
      flash(`Export failed: ${e.message}`, true);
    }
  });
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (event) => {
    const [file] = event.target.files ?? [];
    // Reset so re-picking the same file fires change again.
    event.target.value = '';
    if (file) importRules(file).catch((e) => flash(`Import failed: ${e.message}`, true));
  });

  if (folders.length === 0) {
    flash('No folders found — check the “accountsRead” permission and reload the add-on.', true);
  }
}

init().catch((e) => flash(e.message, true));
