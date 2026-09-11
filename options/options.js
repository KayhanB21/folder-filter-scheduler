/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FIELDS, DOMAIN_IN_LIST, IN_ADDRESS_BOOK, AGE_FIELD, AGE_OPERATORS, ageDays } from '../src/matcher.js';
import { ADDRESS_BOOK_FIELDS, ALL_ADDRESS_BOOKS } from '../src/contacts.js';
import { diagnosticsFilename } from '../src/diagnostics.js';
import { ACTIONS, ACTIONS_BY_ID } from '../src/actions.js';
import { DEFAULT_ALLOWLIST, parseDomainList } from '../src/domains.js';
import { buildExport, exportFilename, sanitizeImport } from '../src/rules.js';

const $ = (sel, root = document) => root.querySelector(sel);
const rulesEl = $('#rules');
const statusEl = $('#status');

let folders = []; // [{ id, label }]

/**
 * Address-book access is an optional permission, asked for only when someone
 * uses an address-book condition, so existing users never see an update
 * prompt. Without it the conditions are still saved; they just never match.
 */
let bookAccess = false;
let addressBooks = []; // local (non-LDAP) AddressBookNodes

async function loadAddressBooks() {
  try {
    bookAccess = await messenger.permissions.contains({ permissions: ['addressBooks'] });
  } catch {
    bookAccess = false;
  }
  addressBooks = [];
  if (!bookAccess || !messenger.addressBooks?.list) return;
  try {
    addressBooks = (await messenger.addressBooks.list(false)).filter((b) => !b.remote);
  } catch (e) {
    console.warn('[FolderFilterScheduler] could not list address books', e);
  }
}

function bookLabel(id) {
  if (id === ALL_ADDRESS_BOOKS) return 'All address books';
  return addressBooks.find((b) => b.id === id)?.name ?? '(missing address book)';
}

function fillBookSelect(select, currentId) {
  select.innerHTML = '';
  const ids = [ALL_ADDRESS_BOOKS, ...addressBooks.map((b) => b.id)];
  // Keep an id from another profile visible rather than silently replacing it.
  if (currentId && !ids.includes(currentId)) ids.push(currentId);
  for (const id of ids) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = bookLabel(id);
    select.append(opt);
  }
  select.value = currentId || ALL_ADDRESS_BOOKS;
}

function fillBookFieldSelect(select, current) {
  select.innerHTML = '';
  for (const field of ADDRESS_BOOK_FIELDS) {
    const opt = document.createElement('option');
    opt.value = field;
    opt.textContent = field;
    select.append(opt);
  }
  select.value = ADDRESS_BOOK_FIELDS.includes(current) ? current : 'from';
}

function refreshBookRows() {
  for (const row of rulesEl.querySelectorAll('.condition')) row.syncBooks?.();
}

function requestBookAccess() {
  // permissions.request must be called directly from the click, before any await.
  messenger.permissions
    .request({ permissions: ['addressBooks'] })
    .then(async (granted) => {
      await loadAddressBooks();
      refreshBookRows();
      flash(
        granted
          ? 'Address book access allowed. Pick a book and press Save.'
          : 'Address book access was not allowed. Address book conditions will not match until it is.',
        !granted,
      );
    })
    .catch((e) => flash(`Could not request address book access: ${e.message}`, true));
}

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

const AGE_OPERATOR_LABELS = { olderThan: 'older than', newerThan: 'newer than' };

function renderCondition(container, cond = {}) {
  const node = $('#condition-template').content.firstElementChild.cloneNode(true);
  const fieldSelect = $('.cond-field', node);
  const op = $('.cond-op', node);
  fillFieldSelect(fieldSelect, cond.field ?? 'reply-to');
  op.value = cond.operator ?? 'contains';
  $('.cond-negate', node).checked = !!cond.negate;
  $('.cond-value', node).value = cond.value ?? '';
  $('.cond-domains', node).value = (cond.domains ?? []).join('\n');
  $('.cond-days', node).value = ageDays(cond) ?? '';

  // The row changes shape with its field and operator. A domain list needs a
  // textarea, not a one-line input: a harvested list runs to hundreds of
  // entries. The age field needs a day count and only its own two operators,
  // since "age contains 3" is meaningless, and the string operators must never
  // be offered for it.
  // The address-book id lives on the row so it survives while access is missing.
  node.dataset.bookId = cond.addressBookId ?? ALL_ADDRESS_BOOKS;
  const bookSelect = $('.cond-book', node);
  const bookGrant = $('.cond-book-grant', node);
  bookSelect.addEventListener('change', () => {
    node.dataset.bookId = bookSelect.value;
  });
  bookGrant.addEventListener('click', requestBookAccess);
  node.syncBooks = () => {
    const isBook = op.value === IN_ADDRESS_BOOK;
    bookSelect.classList.toggle('hidden', !isBook || !bookAccess);
    bookGrant.classList.toggle('hidden', !isBook || bookAccess);
    if (isBook && bookAccess) fillBookSelect(bookSelect, node.dataset.bookId);
  };

  let mode = null; // 'list' | 'book' | 'plain': decides which fields are offered
  const syncRow = () => {
    const isList = op.value === DOMAIN_IN_LIST;
    const isBook = op.value === IN_ADDRESS_BOOK;
    const nextMode = isList ? 'list' : isBook ? 'book' : 'plain';
    if (nextMode !== mode) {
      const previous = mode === null ? (cond.field ?? cond.fields?.[0]) : fieldSelect.value;
      if (isList) fillDomainFieldSelect(fieldSelect, cond);
      else if (isBook) fillBookFieldSelect(fieldSelect, previous);
      else fillFieldSelect(fieldSelect, FIELDS.includes(previous) ? previous : 'reply-to');
      mode = nextMode;
    }

    const isAge = fieldSelect.value === AGE_FIELD;
    for (const option of op.options) {
      const ageOp = option.value in AGE_OPERATORS;
      option.hidden = isAge ? !ageOp : ageOp;
      option.disabled = option.hidden;
    }
    if (isAge && !(op.value in AGE_OPERATORS)) op.value = AGE_OPERATORS.olderThan;
    if (!isAge && op.value in AGE_OPERATORS) op.value = 'contains';

    $('.cond-domains', node).classList.toggle('hidden', !isList);
    $('.cond-value', node).classList.toggle('hidden', isList || isAge || isBook);
    $('.cond-days', node).classList.toggle('hidden', !isAge);
    $('.cond-days-unit', node).classList.toggle('hidden', !isAge);
    node.syncBooks();
  };
  op.addEventListener('change', syncRow);
  fieldSelect.addEventListener('change', syncRow);
  syncRow();

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
    if (field === AGE_FIELD) {
      const opLabel = AGE_OPERATOR_LABELS[$('.cond-op', c).value] ?? $('.cond-op', c).value;
      const days = $('.cond-days', c).value || '?';
      return `age ${negate}${opLabel} ${days} day${days === '1' ? '' : 's'}`;
    }
    if ($('.cond-op', c).value === IN_ADDRESS_BOOK) {
      return `${field} ${negate}in ${bookLabel(c.dataset.bookId)}`;
    }
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
        if (condition.field === AGE_FIELD) {
          // A missing or zero day count is stored as-is and never matches (the
          // matcher guards it); the user is told rather than silently fixed.
          const raw = $('.cond-days', c).value.trim();
          const days = ageDays({ days: raw });
          condition.days = days ?? 0;
          if (days === null) rejected.push(`age condition needs a whole number of days (got "${raw || 'nothing'}")`);
        } else if (operator === IN_ADDRESS_BOOK) {
          condition.addressBookId = c.dataset.bookId || ALL_ADDRESS_BOOKS;
        } else if (operator === DOMAIN_IN_LIST) {
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

  // Address-book conditions are kept even when they cannot run yet, but the
  // user must be told, since a condition that never matches looks like a bug.
  const bookConds = collected.rules.flatMap((r) => r.conditions.filter((c) => c.operator === IN_ADDRESS_BOOK));
  const knownBooks = new Set([ALL_ADDRESS_BOOKS, ...addressBooks.map((b) => b.id)]);
  let bookNote = '';
  if (bookConds.length > 0 && !bookAccess) {
    bookNote = ' Address book conditions will not match until you allow address book access.';
  } else if (bookConds.some((c) => !knownBooks.has(c.addressBookId))) {
    bookNote = ' An address book condition points at a book that no longer exists; it will not match.';
  }

  flash(
    (rejected.length > 0
      ? `Saved. Ignored ${rejected.length} unusable entr${rejected.length === 1 ? 'y' : 'ies'}: ${rejected.join(', ')}.`
      : 'Saved. Schedule updated.') + bookNote,
    bookNote !== '',
  );
}

// --- Diagnostics -------------------------------------------------------------

async function refreshDiagnostics() {
  try {
    const res = await messenger.runtime.sendMessage({
      command: 'diagnostics',
      includeValues: $('#diag-values').checked,
    });
    $('#diag-report').value = res?.report ?? '';
  } catch (e) {
    $('#diag-report').value = `Could not build the report: ${e.message}`;
  }
}

async function copyDiagnostics() {
  const text = $('#diag-report').value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $('#diag-report').select();
    document.execCommand('copy');
  }
  flash('Diagnostics copied. Paste it into your email or GitHub issue.');
}

function saveDiagnostics() {
  const now = new Date();
  const blob = new Blob([$('#diag-report').value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = diagnosticsFilename(now);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  flash(`Saved ${diagnosticsFilename(now)}.`);
}

async function clearDiagnostics() {
  await messenger.runtime.sendMessage({ command: 'clearDiagnostics' });
  await refreshDiagnostics();
  flash('Diagnostics log cleared.');
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
    // Only checkable with access; otherwise ids are kept and checked on use.
    knownAddressBookIds: bookAccess ? addressBooks.map((b) => b.id) : undefined,
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
  await loadAddressBooks();
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

  // Keep book rows honest if access is granted or revoked in the Add-ons Manager
  // while this page is open.
  const onPermissionsChanged = () => loadAddressBooks().then(refreshBookRows);
  messenger.permissions.onAdded?.addListener(onPermissionsChanged);
  messenger.permissions.onRemoved?.addListener(onPermissionsChanged);

  $('#diagnostics-box').addEventListener('toggle', () => {
    if ($('#diagnostics-box').open) refreshDiagnostics();
  });
  $('#diag-values').addEventListener('change', refreshDiagnostics);
  $('#diag-refresh').addEventListener('click', refreshDiagnostics);
  $('#diag-copy').addEventListener('click', () => copyDiagnostics());
  $('#diag-save').addEventListener('click', () => {
    try {
      saveDiagnostics();
    } catch (e) {
      flash(`Could not save the report: ${e.message}`, true);
    }
  });
  $('#diag-clear').addEventListener('click', () =>
    clearDiagnostics().catch((e) => flash(e.message, true)),
  );

  if (folders.length === 0) {
    flash('No folders found — check the “accountsRead” permission and reload the add-on.', true);
  }
}

init().catch((e) => flash(e.message, true));
