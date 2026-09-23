/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { FIELDS, DOMAIN_IN_LIST, IN_ADDRESS_BOOK, AGE_FIELD, AGE_OPERATORS, ageDays } from '../src/matcher.js';
import { ADDRESS_BOOK_FIELDS, ALL_ADDRESS_BOOKS } from '../src/contacts.js';
import { diagnosticsFilename } from '../src/diagnostics.js';
import { ACTIONS, ACTIONS_BY_ID, actionsOf, isTerminalAction, orderActions } from '../src/actions.js';
import { ADVANCED_DEFAULTS, sanitizeAdvanced } from '../src/settings.js';
import { DEFAULT_ALLOWLIST, parseDomainList } from '../src/domains.js';
import { buildExport, exportFilename, sanitizeImport } from '../src/rules.js';
import { folderDepth, folderMatchesFilter, resolveRuleFolders, treeGuides } from '../src/folders.js';

const $ = (sel, root = document) => root.querySelector(sel);

// --- Theme -------------------------------------------------------------------

/**
 * Light, dark, or whatever Thunderbird uses. A per-viewer preference like the
 * collapsed rules, so it lives in localStorage and never in the rules config.
 */
const THEME_KEY = 'ffs.theme';
const THEMES = new Set(['system', 'light', 'dark']);

function applyTheme(theme) {
  const value = THEMES.has(theme) ? theme : 'system';
  if (value === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = value;
  return value;
}

function loadTheme() {
  try {
    return localStorage.getItem(THEME_KEY) ?? 'system';
  } catch {
    return 'system';
  }
}

// Applied before anything renders, so the page does not flash the other theme.
{
  const current = applyTheme(loadTheme());
  const radio = $(`#theme input[value="${current}"]`);
  if (radio) radio.checked = true;
}
$('#theme').addEventListener('change', (e) => {
  const value = applyTheme(e.target.value);
  try {
    localStorage.setItem(THEME_KEY, value);
  } catch {
    // Without localStorage the choice lasts until the page closes.
  }
});

const rulesEl = $('#rules');
const statusEl = $('#status');

let folders = []; // [{ id, label, accountId, accountName, path, name, depth }]
let guides = new Map(); // folder id -> treeGuides() entry, rebuilt with `folders`

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
 * Listing the user's tags needs its own optional permission, asked for only
 * when someone adds a tag action. Applying a tag does not: that goes through
 * messages.update, which the add-on already holds. So a rule whose tag was
 * chosen before the permission was revoked keeps working.
 */
let tagAccess = false;
let tags = []; // MessageTag: { key, tag, color, ordinal }

async function loadTags() {
  try {
    tagAccess = await messenger.permissions.contains({ permissions: ['messagesTagsList'] });
  } catch {
    tagAccess = false;
  }
  tags = [];
  if (!tagAccess || !messenger.messages?.tags?.list) return;
  try {
    tags = await messenger.messages.tags.list();
  } catch (e) {
    console.warn('[FolderFilterScheduler] could not list tags', e);
  }
}

function tagLabel(key) {
  if (!key) return '(no tag)';
  return tags.find((t) => t.key === key)?.tag ?? key;
}

function fillTagSelect(select, currentKey) {
  select.innerHTML = '';
  const keys = tags.map((t) => t.key);
  // Keep a key from another profile visible rather than silently replacing it.
  if (currentKey && !keys.includes(currentKey)) keys.push(currentKey);
  for (const key of keys) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = tagLabel(key);
    select.append(opt);
  }
  select.value = currentKey || keys[0] || '';
}

function refreshTagRows() {
  for (const row of rulesEl.querySelectorAll('.action')) row.syncTags?.();
}

function requestTagAccess() {
  // permissions.request must be called directly from the click, before any await.
  messenger.permissions
    .request({ permissions: ['messagesTagsList'] })
    .then(async (granted) => {
      await loadTags();
      refreshTagRows();
      flash(
        granted
          ? 'Tag access allowed. Pick a tag and press Save.'
          : 'Tag access was not allowed, so your tags cannot be listed here.',
        !granted,
      );
    })
    .catch((e) => flash(`Could not request tag access: ${e.message}`, true));
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

/** One picker entry. `label` is the full "Account: /path" form, for tooltips. */
function folderEntry(folder, accountName) {
  const path = folder.path;
  return {
    id: folder.id,
    label: `${accountName}: ${path}`,
    accountId: folder.accountId,
    accountName,
    path,
    name: folder.name || path.split('/').filter(Boolean).pop() || path,
    depth: folderDepth(path),
    specialUse: folder.specialUse ?? [],
  };
}

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
        flat.push(folderEntry(f, nameByAccount.get(f.accountId) ?? ''));
      }
      if (flat.length) {
        // Grouped by account in the account list's order; the query keeps each
        // account's folders in tree order, and a stable sort preserves that.
        const rank = new Map(accounts.map((a, i) => [a.id, i]));
        folders = flat.sort((a, b) => (rank.get(a.accountId) ?? 0) - (rank.get(b.accountId) ?? 0));
        guides = treeGuides(folders);
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
      flat.push(folderEntry(folder, accountName));
    }
    for (const child of folder.subFolders ?? []) walk(child, accountName);
  };
  for (const account of withSubs) {
    walk(account.rootFolder ?? account, account.name);
  }
  folders = flat;
  guides = treeGuides(folders);
}

const INDENT_EM = 1.25;
const GUIDE = 'color-mix(in srgb, currentColor 65%, transparent)';
const DASH_DOWN = `repeating-linear-gradient(to bottom, ${GUIDE} 0 2px, transparent 2px 4px)`;
const DASH_RIGHT = `repeating-linear-gradient(to right, ${GUIDE} 0 2px, transparent 2px 4px)`;

/**
 * Dashed tree lines for one option, as background layers.
 *
 * A native <option> holds text only, so the lines are gradients: one vertical
 * dash per level the tree passes through, and an elbow into this folder. The
 * option stays a real option, so keyboard and screen reader behaviour is the
 * same as any other <select>.
 */
function guideBackground(guide) {
  const layers = [];
  const x = (level) => `${level * INDENT_EM + 0.75}em`;
  guide.through.forEach((through, level) => {
    const own = level === guide.through.length - 1;
    if (own) {
      // The elbow: down from the top (to the middle when this is the last
      // child), then right towards the name.
      layers.push({ image: DASH_DOWN, size: `1px ${guide.last ? '50%' : '100%'}`, position: `${x(level)} 0` });
      layers.push({ image: DASH_RIGHT, size: '0.6em 1px', position: `${x(level)} 50%` });
    } else if (through) {
      layers.push({ image: DASH_DOWN, size: '1px 100%', position: `${x(level)} 0` });
    }
  });
  return {
    backgroundImage: layers.map((l) => l.image).join(', '),
    backgroundSize: layers.map((l) => l.size).join(', '),
    backgroundPosition: layers.map((l) => l.position).join(', '),
  };
}

/**
 * Write one folder option. Indentation is CSS padding, so levels line up and a
 * screen reader hears the name rather than blank space. While filtering, the
 * tree is gone, so the option shows the whole path and no lines.
 */
function paintFolderOption(opt, folder, { filtering = false, covered = false } = {}) {
  const depth = Math.max(1, folder.depth);
  const name = filtering ? folder.path.replace(/^\//, '') : folder.name;
  const note = covered ? ' · included as a subfolder' : '';
  opt.textContent = `${name}${note}`;
  opt.setAttribute('aria-label', `${name}${note}`);
  opt.style.paddingInlineStart = filtering ? '' : `${(depth - 1) * INDENT_EM + 0.4}em`;
  const guide = guides.get(folder.id);
  const lines = !filtering && guide && guide.through.length > 0 ? guideBackground(guide) : null;
  opt.style.backgroundImage = lines?.backgroundImage ?? '';
  opt.style.backgroundSize = lines?.backgroundSize ?? '';
  opt.style.backgroundPosition = lines?.backgroundPosition ?? '';
  opt.classList.toggle('covered', covered);
  opt.classList.toggle('top-level', !filtering && depth === 1);
}

/**
 * One <optgroup> per account, each folder indented under its parent.
 *
 * Still a native <select>, so arrow keys, Shift+arrow, type-ahead and screen
 * readers work as they do everywhere else in Thunderbird.
 */
function fillFolderSelect(select, selectedIds = []) {
  select.innerHTML = '';
  let group = null;
  for (const f of folders) {
    if (!group || group.dataset.accountId !== f.accountId) {
      group = document.createElement('optgroup');
      group.label = f.accountName || 'Account';
      group.dataset.accountId = f.accountId ?? '';
      select.append(group);
    }
    const opt = document.createElement('option');
    opt.value = f.id;
    paintFolderOption(opt, f);
    opt.title = f.label;
    opt.selected = selectedIds.includes(f.id);
    group.append(opt);
  }
}

/**
 * Filter box, "Select all matching", and the selection count for one rule.
 *
 * Filtering only hides options. A hidden option keeps its selected state, so a
 * folder picked earlier stays in the rule while you search for another, and the
 * count says how many of the selected folders the filter hides.
 */
function wireFolderPicker(node) {
  const filter = $('.folder-filter', node);
  const select = $('.rule-folders', node);
  const selectMatching = $('.folder-select-matching', node);
  const count = $('.folder-count', node);
  const byId = new Map(folders.map((f) => [f.id, f]));

  const subfolders = $('.rule-subfolders', node);

  /**
   * Folders the rule scans without being picked. Worked out by the engine's own
   * `resolveRuleFolders`, so a Trash folder or a move destination the engine
   * skips is not marked here either.
   */
  const coveredIds = () => {
    if (!subfolders.checked) return new Set();
    const chosen = [...select.selectedOptions].map((o) => o.value);
    const actions = [...node.querySelectorAll('.action')].map((row) => ({
      type: $('.action-type', row).value,
      folderId: $('.action-folder', row).value,
    }));
    const scanned = resolveRuleFolders({ folderIds: chosen, includeSubfolders: true, actions }, folders);
    return new Set(scanned.filter((id) => !chosen.includes(id)));
  };

  const updateCount = () => {
    const selected = [...select.selectedOptions];
    const hidden = selected.filter((o) => o.hidden).length;
    const covered = coveredIds();
    count.textContent =
      `${selected.length} selected` +
      (covered.size ? `, ${covered.size} more as subfolders` : '') +
      (hidden ? `, ${hidden} hidden by the filter` : '');
    return covered;
  };
  const applyFilter = () => {
    const text = filter.value;
    const filtering = text.trim() !== '';
    const covered = updateCount();
    for (const group of select.querySelectorAll('optgroup')) {
      let visible = 0;
      for (const opt of group.children) {
        const folder = byId.get(opt.value);
        opt.hidden = !folderMatchesFilter(folder, text);
        if (!opt.hidden) visible += 1;
        if (folder) paintFolderOption(opt, folder, { filtering, covered: covered.has(folder.id) });
      }
      group.hidden = visible === 0;
    }
    // With no filter, "all matching" would be every folder in every account.
    selectMatching.disabled = !filtering;
  };

  filter.addEventListener('input', applyFilter);
  filter.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    select.focus();
  });
  selectMatching.addEventListener('click', () => {
    for (const opt of select.options) if (!opt.hidden) opt.selected = true;
    applyFilter();
  });
  // Repainted on each change, because the covered marks follow the selection,
  // the checkbox, and any move or copy destination among the actions.
  select.addEventListener('change', applyFilter);
  subfolders.addEventListener('change', applyFilter);
  node.addEventListener('change', (e) => {
    if (e.target.closest?.('.actions')) applyFilter();
  });
  applyFilter();
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

/**
 * One action row. A rule may hold several; the engine forces the one that moves
 * or deletes to run last, so the order of the rows here is presentational.
 */
function renderAction(container, action = {}) {
  const node = $('#action-template').content.firstElementChild.cloneNode(true);
  const type = $('.action-type', node);
  const folder = $('.action-folder', node);
  const tag = $('.action-tag', node);
  const tagGrant = $('.action-tag-grant', node);
  const hint = $('.action-hint', node);

  // Nothing is pre-selected. A default of "Move to Trash" meant a user who added
  // a tag action and missed the row above it would trash the mail they meant to
  // tag, so a new row starts on this placeholder and save refuses it.
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose an action…';
  type.append(placeholder);

  // Populate from the registry — the UI stays in lockstep with the engine.
  for (const def of ACTIONS) {
    const opt = document.createElement('option');
    opt.value = def.id;
    opt.textContent = def.label;
    type.append(opt);
  }
  type.value = ACTIONS_BY_ID[action.type] ? action.type : '';
  fillFolderSelect(folder, action.folderId ? [action.folderId] : []);

  // The chosen tag lives on the row so it survives while access is missing.
  node.dataset.tagKey = action.tagKey ?? '';
  tag.addEventListener('change', () => {
    node.dataset.tagKey = tag.value;
  });
  tagGrant.addEventListener('click', requestTagAccess);
  node.syncTags = () => {
    const needsTag = ACTIONS_BY_ID[type.value]?.needsTag === true;
    tag.classList.toggle('hidden', !needsTag || !tagAccess);
    tagGrant.classList.toggle('hidden', !needsTag || tagAccess);
    if (needsTag && tagAccess) {
      fillTagSelect(tag, node.dataset.tagKey);
      node.dataset.tagKey = tag.value;
    }
  };

  const sync = () => {
    const def = ACTIONS_BY_ID[type.value];
    folder.classList.toggle('hidden', !def?.needsFolder);
    hint.textContent = def?.hint ?? 'Pick what should happen to matching messages.';
    node.classList.toggle('unchosen', !def);
    hint.classList.toggle('danger', !!def?.danger);
    node.syncTags();
  };
  type.addEventListener('change', sync);
  sync();

  $('.del-action', node).addEventListener('click', () => {
    // A rule with no action would do nothing but still scan every folder.
    if (container.querySelectorAll('.action').length <= 1) {
      flash('A rule needs at least one action.', true);
      return;
    }
    node.remove();
  });

  container.append(node);
}

function renderRule(rule = {}) {
  const node = $('#rule-template').content.firstElementChild.cloneNode(true);
  $('.rule-id', node).value = rule.id ?? crypto.randomUUID();
  $('.rule-name', node).value = rule.name ?? 'New rule';
  $('.rule-enabled', node).checked = rule.enabled !== false;
  $('.rule-match', node).value = rule.match ?? 'any';
  fillFolderSelect($('.rule-folders', node), rule.folderIds ?? []);
  $('.rule-subfolders', node).checked = rule.includeSubfolders === true;

  const condContainer = $('.conditions', node);
  const conds = rule.conditions?.length ? rule.conditions : [{}];
  for (const c of conds) renderCondition(condContainer, c);
  $('.add-cond', node).addEventListener('click', () => renderCondition(condContainer, {}));

  const actionContainer = $('.actions', node);
  const actions = actionsOf(rule);
  for (const a of orderActions(actions.length ? actions : [{}])) {
    renderAction(actionContainer, a);
  }
  $('.add-action', node).addEventListener('click', () => renderAction(actionContainer, {}));
  wireFolderPicker(node);

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
  // Listed in execution order, not row order, so the digest matches what runs.
  const actions = orderActions(
    [...node.querySelectorAll('.action')].map((a) => ({
      type: $('.action-type', a).value,
      tagKey: a.dataset.tagKey,
    })),
  ).map((a) => {
    const def = ACTIONS_BY_ID[a.type];
    if (!def) return 'no action';
    // "Tag as…" reads badly with the tag appended; the ellipsis means "picker".
    return def.needsTag ? `${def.label.replace(/…$/, '')} ${tagLabel(a.tagKey)}` : def.label;
  });
  const folderCount = $('.rule-folders', node).selectedOptions.length;
  const subs = $('.rule-subfolders', node).checked ? ' and subfolders' : '';
  const where = `${folderCount} folder${folderCount === 1 ? '' : 's'}${subs}`;
  const what = conditions.join(joiner) || 'no conditions';

  return `${what} → ${actions.join(' + ') || 'no action'} · ${where}`;
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

/**
 * Read one rule's action rows back, in execution order.
 *
 * Only one action may consume the message: after a move or a delete the ids are
 * no longer valid, so a second such action would fail silently at 3am. Extras
 * are dropped here, while the user is still looking at the page.
 */
function collectActions(node, ruleName, rejected) {
  const fromRows = [...node.querySelectorAll('.action')].flatMap((row) => {
    const type = $('.action-type', row).value;
    // An unchosen row blocks save (see `unchosenActions`); export skips it.
    if (!ACTIONS_BY_ID[type]) return [];
    const def = ACTIONS_BY_ID[type];
    const action = { type };
    if (def?.needsFolder) action.folderId = $('.action-folder', row).value;
    if (def?.needsTag) action.tagKey = row.dataset.tagKey || '';
    return [action];
  });

  const actions = [];
  let terminal = null;
  for (const action of orderActions(fromRows)) {
    if (ACTIONS_BY_ID[action.type]?.needsTag && !action.tagKey) {
      rejected.push(`rule “${ruleName}”: tag action with no tag chosen`);
      continue;
    }
    if (isTerminalAction(action)) {
      if (terminal) {
        rejected.push(`rule “${ruleName}”: only one action can move or delete, dropped “${action.type}”`);
        continue;
      }
      terminal = action.type;
    }
    actions.push(action);
  }
  return actions;
}

/** Read the DOM back into a config object. */
function collectConfig(rejected = []) {
  const rules = [...rulesEl.querySelectorAll('.rule')].map((node) => {
    const name = $('.rule-name', node).value.trim() || 'Untitled rule';
    const actions = collectActions(node, name, rejected);
    return {
      id: $('.rule-id', node).value || crypto.randomUUID(),
      name,
      enabled: $('.rule-enabled', node).checked,
      match: $('.rule-match', node).value,
      folderIds: [...$('.rule-folders', node).selectedOptions].map((o) => o.value),
      includeSubfolders: $('.rule-subfolders', node).checked,
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
      actions,
    };
  });

  const { domains: allowlist } = parseDomainList($('#allowlist').value);
  const advanced = sanitizeAdvanced(collectAdvanced());
  rejected.push(...advanced.problems);
  return {
    intervalMinutes: Math.max(1, Number($('#interval').value) || 10),
    advanced: advanced.settings,
    rules,
    allowlist,
  };
}

// --- Advanced ----------------------------------------------------------------

/** Each advanced setting and the input that holds it. */
const ADVANCED_INPUTS = {
  runOnNewMail: '#adv-new-mail',
  newMailDelaySeconds: '#adv-new-mail-delay',
  catchUpEveryMinutes: '#adv-catchup-every',
  catchUpLookbackDays: '#adv-catchup-days',
  scanOverlapMinutes: '#adv-overlap',
};

function fillAdvanced(settings) {
  for (const [key, selector] of Object.entries(ADVANCED_INPUTS)) {
    const el = $(selector);
    if (key === 'runOnNewMail') el.checked = settings[key] !== false;
    else el.value = settings[key];
  }
}

/** Raw values straight from the inputs; settings.js does the clamping. */
function collectAdvanced() {
  const raw = {};
  for (const [key, selector] of Object.entries(ADVANCED_INPUTS)) {
    const el = $(selector);
    raw[key] = key === 'runOnNewMail' ? el.checked : el.value.trim();
  }
  return raw;
}

function flash(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? 'var(--danger)' : 'var(--accent-text)';
}

/** Action rows still on "Choose an action…", with the name of their rule. */
function unchosenActions() {
  return [...rulesEl.querySelectorAll('.rule')].flatMap((node) =>
    [...node.querySelectorAll('.action')]
      .filter((row) => !ACTIONS_BY_ID[$('.action-type', row).value])
      .map(() => $('.rule-name', node).value.trim() || 'Untitled rule'),
  );
}

async function save() {
  // Refuse rather than correct: dropping the row could leave a rule with no
  // action, and guessing one is exactly the mistake this check exists to stop.
  const unchosen = unchosenActions();
  if (unchosen.length > 0) {
    const names = [...new Set(unchosen)].map((n) => `“${n}”`).join(', ');
    for (const node of rulesEl.querySelectorAll('.rule')) {
      if (node.querySelector('.action.unchosen')) setCollapsed(node, false);
    }
    rulesEl.querySelector('.action.unchosen .action-type')?.focus();
    flash(`Not saved: choose an action for ${names}.`, true);
    return;
  }

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
  fillAdvanced(collected.advanced);

  // Address-book conditions are kept even when they cannot run yet, but the
  // user must be told, since a condition that never matches looks like a bug.
  const tagActions = collected.rules.flatMap((r) => r.actions.filter((a) => a.type === 'tag'));
  const bookConds = collected.rules.flatMap((r) => r.conditions.filter((c) => c.operator === IN_ADDRESS_BOOK));
  const knownBooks = new Set([ALL_ADDRESS_BOOKS, ...addressBooks.map((b) => b.id)]);
  let note = '';
  if (bookConds.length > 0 && !bookAccess) {
    note = ' Address book conditions will not match until you allow address book access.';
  } else if (bookConds.some((c) => !knownBooks.has(c.addressBookId))) {
    note = ' An address book condition points at a book that no longer exists; it will not match.';
  }
  // Tagging itself works without messagesTagsList; only the picker needs it.
  if (tagActions.length > 0 && tagAccess && tagActions.some((a) => !tags.some((t) => t.key === a.tagKey))) {
    note += ' A tag action points at a tag that no longer exists.';
  }

  flash(
    (rejected.length > 0
      ? `Saved, with ${rejected.length} correction${rejected.length === 1 ? '' : 's'}: ${rejected.join('; ')}.`
      : 'Saved. Schedule updated.') + note,
    note !== '',
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

  const { rules, duplicates, allowlist, intervalMinutes, advanced, problems } = sanitizeImport(data, {
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
  if (advanced) fillAdvanced(advanced);

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
  await loadTags();
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

  fillAdvanced(sanitizeAdvanced(config?.advanced).settings);
  $('#reset-advanced').addEventListener('click', () => {
    fillAdvanced(ADVANCED_DEFAULTS);
    flash('Advanced settings restored to defaults. Press Save to keep them.');
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
  const onPermissionsChanged = () =>
    Promise.all([loadAddressBooks().then(refreshBookRows), loadTags().then(refreshTagRows)]);
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
