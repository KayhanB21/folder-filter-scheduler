/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  FIELDS,
  DOMAIN_IN_LIST,
  IN_ADDRESS_BOOK,
  NAME_SHOWS_OTHER_ADDRESS,
  AGE_FIELD,
  AGE_OPERATORS,
  STATE_FIELDS,
  STATE_OPERATORS,
  TAG_FIELD,
  HAS_TAG,
  PRIORITY_FIELD,
  PRIORITY_IS,
  PRIORITY_LEVELS,
  AUTH_FIELD,
  AUTH_PASSES,
  AUTH_METHODS,
  ageDays,
} from '../src/matcher.js';
import { ADDRESS_BOOK_FIELDS, ALL_ADDRESS_BOOKS } from '../src/contacts.js';
import { diagnosticsFilename } from '../src/diagnostics.js';
import { ACTIONS, ACTIONS_BY_ID, actionsOf, isTerminalAction, orderActions } from '../src/actions.js';
import { ADVANCED_DEFAULTS, dohOrigin, sanitizeAdvanced } from '../src/settings.js';
import { DEFAULT_ALLOWLIST, parseDomainList } from '../src/domains.js';
import { buildExport, exportFilename, sanitizeImport } from '../src/rules.js';
import { collapsedTree, folderDepth, folderMatchesFilter, resolveRuleFolders, treeGuides } from '../src/folders.js';
import { describeCron, nextRun, parseCron } from '../src/cron.js';
import { applyI18n, formatList, plural, t } from '../src/i18n.js';

const $ = (sel, root = document) => root.querySelector(sel);

// Before anything reads or clones the page, so every text, and every
// template, is in the user's language from the start.
applyI18n();

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
  if (id === ALL_ADDRESS_BOOKS) return t('cond_allAddressBooks');
  return addressBooks.find((b) => b.id === id)?.name ?? t('cond_missingAddressBook');
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
    opt.textContent = fieldLabel(field);
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
        granted ? t('status_bookAccessAllowed') : t('status_bookAccessDenied'),
        !granted,
      );
    })
    .catch((e) => flash(t('status_bookAccessFailed', e.message), true));
}

/**
 * The own DKIM check sends DNS lookups to the server chosen under Advanced, so
 * it needs that server as an optional host permission. It is asked for only
 * when someone uses an authentication condition.
 */
let dnsAccess = false;

async function loadDnsAccess() {
  const origin = dohOrigin($('#adv-auth-server').value);
  try {
    dnsAccess = origin ? await messenger.permissions.contains({ origins: [origin] }) : false;
  } catch {
    dnsAccess = false;
  }
}

function refreshDnsRows() {
  for (const row of rulesEl.querySelectorAll('.condition')) row.syncDns?.();
}

function requestDnsAccess() {
  const origin = dohOrigin($('#adv-auth-server').value);
  if (!origin) return;
  // permissions.request must be called directly from the click, before any await.
  messenger.permissions
    .request({ origins: [origin] })
    .then(async (granted) => {
      await loadDnsAccess();
      refreshDnsRows();
      flash(
        granted ? t('status_dnsAccessAllowed') : t('status_dnsAccessDenied'),
        !granted,
      );
    })
    .catch((e) => flash(t('status_dnsAccessFailed', e.message), true));
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
  if (!key) return t('common_noTag');
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
  for (const row of rulesEl.querySelectorAll('.action, .condition')) row.syncTags?.();
}

function requestTagAccess() {
  // permissions.request must be called directly from the click, before any await.
  messenger.permissions
    .request({ permissions: ['messagesTagsList'] })
    .then(async (granted) => {
      await loadTags();
      refreshTagRows();
      flash(
        granted ? t('status_tagAccessAllowed') : t('status_tagAccessDenied'),
        !granted,
      );
    })
    .catch((e) => flash(t('status_tagAccessFailed', e.message), true));
}

/**
 * Which rules are collapsed. This is a view preference only: it lives in
 * localStorage, never in the stored config, so collapsing a rule cannot change
 * what is saved or exported.
 */
const COLLAPSED_KEY = 'ffs.collapsedRules';
/** Accounts and folders collapsed in the folder picker, shared by every rule. Also a view preference. */
const COLLAPSED_FOLDERS_KEY = 'ffs.collapsedFolders';

function loadCollapsed(key = COLLAPSED_KEY) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) ?? '[]'));
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids, key = COLLAPSED_KEY) {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // A missing localStorage only costs the preference, never the rules.
  }
}

let collapsed = loadCollapsed();
const collapsedFolders = loadCollapsed(COLLAPSED_FOLDERS_KEY);

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
 * The arrow in front of an account and of a folder that has subfolders. An
 * option holds plain text, so the size comes from the character. U+FE0E keeps
 * macOS from drawing the right arrow as a colored emoji.
 */
const ARROWS = { open: '\u25BC\uFE0E ', closed: '\u25B6\uFE0E ' };
/** A collapsed account sits in `collapsedFolders` under this prefix and its id. */
const ACCOUNT_PREFIX = 'account:';

/**
 * Write one folder option. Indentation is CSS padding, so levels line up and a
 * screen reader hears the name rather than blank space. While filtering, the
 * tree is gone, so the option shows the whole path, no lines, and no arrow.
 *
 * `arrow` is `open` or `closed` for a folder with subfolders, and `inside`
 * counts the selected folders a collapsed one hides.
 */
function paintFolderOption(opt, folder, { filtering = false, covered = false, arrow = null, inside = 0 } = {}) {
  const depth = Math.max(1, folder.depth);
  const name = filtering ? folder.path.replace(/^\//, '') : folder.name;
  let note = covered ? ` · ${t('folders_includedAsSubfolder')}` : '';
  if (inside) note += ` · ${plural('folders_selectedInside', inside, inside)}`;
  opt.textContent = `${arrow ? ARROWS[arrow] : ''}${name}${note}`;
  const state = arrow ? `, ${arrow === 'open' ? t('folders_expanded') : t('folders_collapsed')}` : '';
  opt.setAttribute('aria-label', `${name}${state}${note}`);
  opt.dataset.arrow = arrow ?? '';
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
      group.label = f.accountName || t('folders_account');
      group.dataset.name = group.label;
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

  const applyFilter = () => {
    const text = filter.value;
    const filtering = text.trim() !== '';
    const covered = coveredIds();
    // A filter shows every match, so it opens collapsed folders while it runs.
    const tree = collapsedTree(folders, filtering ? new Set() : collapsedFolders);
    const selectedIds = [...select.selectedOptions].map((o) => o.value);
    const insideOf = (folder) => selectedIds.filter((id) => {
      const other = byId.get(id);
      return other?.accountId === folder.accountId && other.path.startsWith(`${folder.path}/`);
    }).length;
    let filtered = 0;
    let folded = 0;
    for (const group of select.querySelectorAll('optgroup')) {
      const accountKey = ACCOUNT_PREFIX + group.dataset.accountId;
      const accountClosed = !filtering && collapsedFolders.has(accountKey);
      let visible = 0;
      for (const opt of group.children) {
        const folder = byId.get(opt.value);
        const matches = folderMatchesFilter(folder, text);
        opt.hidden = !matches || accountClosed || tree.hidden.has(opt.value);
        if (!opt.hidden) visible += 1;
        if (opt.selected && !matches) filtered += 1;
        else if (opt.selected && opt.hidden) folded += 1;
        if (!folder) continue;
        let arrow = null;
        if (!filtering && tree.parents.has(folder.id)) arrow = collapsedFolders.has(folder.id) ? 'closed' : 'open';
        const inside = arrow === 'closed' ? insideOf(folder) : 0;
        paintFolderOption(opt, folder, { filtering, covered: covered.has(folder.id), arrow, inside });
      }
      // A collapsed account keeps its heading, so you can open it again.
      group.hidden = visible === 0 && !accountClosed;
      const inside = accountClosed ? [...group.children].filter((o) => o.selected).length : 0;
      group.label =
        (filtering ? '' : ARROWS[accountClosed ? 'closed' : 'open']) +
        group.dataset.name +
        (inside ? ` · ${plural('folders_selectedInside', inside, inside)}` : '');
    }
    count.textContent = formatList(
      [
        plural('folders_countSelected', selectedIds.length, selectedIds.length),
        covered.size ? plural('folders_countSubfolders', covered.size, covered.size) : '',
        filtered ? plural('folders_countFiltered', filtered, filtered) : '',
        folded ? plural('folders_countFolded', folded, folded) : '',
      ].filter(Boolean),
      'unit',
    );
    // With no filter, "all matching" would be every folder in every account.
    selectMatching.disabled = !filtering;
  };

  // A click on the arrow collapses or expands the folder instead of selecting
  // it. The arrow is the first character after the indent, so the click lands
  // on it when it falls within about one character of the padding edge.
  // Every account and every folder with subfolders, for "Collapse all".
  // "Expand all" clears the set, which also forgets folders that no longer exist.
  $('.folder-collapse-all', node).addEventListener('click', () => {
    const accounts = new Set(folders.map((f) => ACCOUNT_PREFIX + (f.accountId ?? '')));
    for (const id of [...accounts, ...collapsedTree(folders).parents]) collapsedFolders.add(id);
    saveCollapsed(collapsedFolders, COLLAPSED_FOLDERS_KEY);
    refreshFolderPickers();
  });
  $('.folder-expand-all', node).addEventListener('click', () => {
    collapsedFolders.clear();
    saveCollapsed(collapsedFolders, COLLAPSED_FOLDERS_KEY);
    refreshFolderPickers();
  });

  // A click anywhere on an account heading collapses or expands the account.
  select.addEventListener('mousedown', (event) => {
    if (filter.value.trim() !== '') return;
    let id;
    if (event.target instanceof HTMLOptGroupElement) {
      id = ACCOUNT_PREFIX + event.target.dataset.accountId;
    } else {
      const opt = event.target.closest?.('option');
      if (!opt?.dataset.arrow) return;
      const style = getComputedStyle(opt);
      const start = opt.getBoundingClientRect().left + parseFloat(style.paddingInlineStart);
      const x = event.clientX - start;
      if (x < -2 || x > parseFloat(style.fontSize) * 1.4) return;
      id = opt.value;
    }
    event.preventDefault();
    // If the list still changes the selection on this click, put it back.
    const before = new Set([...select.selectedOptions].map((o) => o.value));
    setTimeout(() => {
      for (const o of select.options) o.selected = before.has(o.value);
      applyFilter();
    }, 0);
    if (collapsedFolders.has(id)) collapsedFolders.delete(id);
    else collapsedFolders.add(id);
    saveCollapsed(collapsedFolders, COLLAPSED_FOLDERS_KEY);
    refreshFolderPickers();
  });

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
  node.refreshFolders = applyFilter;
  applyFilter();
}

/** Every rule shares the collapsed folders, so a change repaints each picker. */
function refreshFolderPickers() {
  for (const node of rulesEl.querySelectorAll('.rule')) node.refreshFolders?.();
}

/**
 * The name of a field in the list. The stored value never changes; only the
 * text does. A message key cannot hold "-", so "reply-to" reads `field_reply_to`.
 */
const fieldLabel = (field) => t(`field_${field.replace(/-/g, '_')}`);

/** A field or a comma-joined set of fields as prose: "reply-to or from". */
const fieldsLabel = (value) => formatList(value.split(',').map(fieldLabel), 'disjunction');

/** A domain-list condition can watch several headers at once. */
const DOMAIN_FIELD_SETS = ['reply-to,from', 'reply-to', 'from'].map((value) => ({
  value,
  get label() { return fieldsLabel(value); },
}));

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
    opt.textContent = fieldLabel(field);
    opt.selected = field === value;
    select.append(opt);
  }
}

/**
 * The field select lists every field. A field that the operator rules out is
 * greyed, with the reason on hover, so the user can tell what to change to
 * reach it. This adds those fields after the ones the fill functions offer.
 */
const GREY_FIELD_REASONS = {
  get list() { return t('cond_greyFieldList'); },
  get address() { return t('cond_greyFieldAddress'); },
};

function greyOtherFields(select, mode) {
  const offered = new Set([...select.options].map((o) => o.value));
  const [bothHeaders] = DOMAIN_FIELD_SETS;
  for (const { value, label } of [...FIELDS.map((f) => ({ value: f, label: fieldLabel(f) })), bothHeaders]) {
    if (offered.has(value)) continue;
    const isSet = value === bothHeaders.value;
    const opt = document.createElement('option');
    opt.value = value;
    opt.disabled = true;
    opt.textContent = isSet ? t('cond_domainListOnly', label) : label;
    opt.title = isSet ? t('cond_greyDomainSet') : GREY_FIELD_REASONS[mode];
    select.append(opt);
  }
}

/**
 * The same for operators, by the kind of field each one needs. `suffix` is a
 * message with the label as `$1`, or null when the label alone says enough.
 */
const GREY_OPERATORS = {
  age: { suffix: 'op_ageOnly', reason: 'op_ageOnlyReason' },
  state: { suffix: null, reason: 'op_stateOnlyReason' },
  tag: { suffix: 'op_tagOnly', reason: 'op_tagOnlyReason' },
  priority: { suffix: null, reason: 'op_priorityOnlyReason' },
  auth: { suffix: 'op_authOnly', reason: 'op_authOnlyReason' },
  plain: { suffix: 'op_headerOnly', reason: 'op_headerOnlyReason' },
};
/** The greyed text names the field, because "is" alone says nothing there. */
const GREY_OPERATOR_LABELS = {
  get isOn() { return t('op_greyIsOn'); },
  get isOff() { return t('op_greyIsOff'); },
  get priorityIs() { return t('op_greyPriorityIs'); },
};

/** "is read", "is not starred", and so on. STATE_LABELS stays English for the log. */
const stateLabel = (field, operator) => t(`state_${field}_${operator}`);

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
  // A new priority row starts on High: the level people most often filter on.
  $('.cond-priority', node).value = PRIORITY_LEVELS.includes(cond.value) ? cond.value : 'high';
  // A new authentication row starts on DKIM: the check the add-on runs itself.
  $('.cond-auth', node).value = AUTH_METHODS.includes(cond.value) ? cond.value : 'dkim';
  $('.cond-auth-grant', node).addEventListener('click', requestDnsAccess);

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

  // The tag key lives on the row for the same reason.
  node.dataset.tagKey = cond.tagKey ?? '';
  const tagSelect = $('.cond-tag', node);
  const tagGrant = $('.cond-tag-grant', node);
  tagSelect.addEventListener('change', () => {
    node.dataset.tagKey = tagSelect.value;
  });
  tagGrant.addEventListener('click', requestTagAccess);
  node.syncTags = () => {
    const isTag = fieldSelect.value === TAG_FIELD;
    tagSelect.classList.toggle('hidden', !isTag || !tagAccess);
    tagGrant.classList.toggle('hidden', !isTag || tagAccess);
    if (isTag && tagAccess) {
      fillTagSelect(tagSelect, node.dataset.tagKey);
      node.dataset.tagKey = tagSelect.value;
    }
  };

  let mode = null; // 'list' | 'address' | 'plain': decides which fields are offered
  // Operators the field rules out move under this heading at the end of the
  // list. Thunderbird draws a disabled option in the normal text color in
  // some menus, so the heading, not the color, sets them apart.
  const opOrder = [...op.options];
  const otherOps = document.createElement('optgroup');
  otherOps.label = t('cond_otherFields');
  otherOps.disabled = true;
  const syncRow = () => {
    const isList = op.value === DOMAIN_IN_LIST;
    const isBook = op.value === IN_ADDRESS_BOOK;
    const isName = op.value === NAME_SHOWS_OTHER_ADDRESS;
    // Both read addresses, so they offer the same fields.
    const isAddress = isBook || isName;
    const nextMode = isList ? 'list' : isAddress ? 'address' : 'plain';
    if (nextMode !== mode) {
      const previous = mode === null ? (cond.field ?? cond.fields?.[0]) : fieldSelect.value;
      if (isList) fillDomainFieldSelect(fieldSelect, cond);
      else if (isAddress) fillBookFieldSelect(fieldSelect, previous);
      else fillFieldSelect(fieldSelect, FIELDS.includes(previous) ? previous : 'reply-to');
      greyOtherFields(fieldSelect, nextMode);
      mode = nextMode;
    }

    // Age, the three states, tag, and priority each take their own operators
    // and nothing else. Every other field takes the rest. An operator that the
    // field rules out stays in the list, greyed and under its own heading, with
    // the reason on hover.
    const field = fieldSelect.value;
    const isAge = field === AGE_FIELD;
    const isState = STATE_FIELDS.includes(field);
    const isTag = field === TAG_FIELD;
    const isPriority = field === PRIORITY_FIELD;
    const isAuth = field === AUTH_FIELD;
    const kindOf = (value) => {
      if (value in AGE_OPERATORS) return 'age';
      if (value in STATE_OPERATORS) return 'state';
      if (value === PRIORITY_IS) return 'priority';
      if (value === AUTH_PASSES) return 'auth';
      return value === HAS_TAG ? 'tag' : 'plain';
    };
    let kind = 'plain';
    if (isAge) kind = 'age';
    else if (isState) kind = 'state';
    else if (isTag) kind = 'tag';
    else if (isPriority) kind = 'priority';
    else if (isAuth) kind = 'auth';
    for (const option of op.options) {
      const needs = kindOf(option.value);
      option.dataset.label ??= option.textContent;
      option.disabled = needs !== kind;
      option.title = option.disabled ? t(GREY_OPERATORS[needs].reason) : '';
      if (option.disabled) {
        const label = GREY_OPERATOR_LABELS[option.value] ?? option.dataset.label;
        const { suffix } = GREY_OPERATORS[needs];
        option.textContent = suffix ? t(suffix, label) : label;
      } else if (isState && option.value in STATE_OPERATORS) {
        option.textContent = stateLabel(field, option.value);
      } else {
        option.textContent = option.dataset.label;
      }
    }
    const chosen = op.value;
    for (const option of opOrder) if (!option.disabled) op.append(option);
    for (const option of opOrder) if (option.disabled) otherOps.append(option);
    op.append(otherOps);
    op.value = chosen;
    if (kindOf(op.value) !== kind) {
      op.value = {
        age: AGE_OPERATORS.olderThan,
        state: STATE_OPERATORS.isOn,
        tag: HAS_TAG,
        priority: PRIORITY_IS,
        auth: AUTH_PASSES,
        plain: 'contains',
      }[kind];
    }

    // "is unread" already says "not read", so a state row has no "not" box.
    const negate = $('.cond-negate', node);
    negate.closest('label').classList.toggle('hidden', isState);
    if (isState) negate.checked = false;

    $('.cond-domains', node).classList.toggle('hidden', !isList);
    $('.cond-value', node).classList.toggle(
      'hidden', isList || isAge || isAddress || isState || isTag || isPriority || isAuth,
    );
    $('.cond-priority', node).classList.toggle('hidden', !isPriority);
    $('.cond-priority-hint', node).classList.toggle('hidden', !isPriority);
    $('.cond-auth', node).classList.toggle('hidden', !isAuth);
    $('.cond-auth-hint', node).classList.toggle('hidden', !isAuth);
    node.syncDns();
    $('.cond-hint', node).classList.toggle('hidden', !isName);
    $('.cond-state-hint', node).classList.toggle('hidden', !isState && !isTag);
    $('.cond-days', node).classList.toggle('hidden', !isAge);
    $('.cond-days-unit', node).classList.toggle('hidden', !isAge);
    node.syncBooks();
    node.syncTags();
  };
  // The grant button shows only while the own check is on and the DNS server
  // is not allowed yet, because DKIM and DMARC never match until then.
  node.syncDns = () => {
    const isAuth = fieldSelect.value === AUTH_FIELD;
    const wantsDns = $('#adv-auth-own').checked && $('.cond-auth', node).value !== 'spf';
    $('.cond-auth-grant', node).classList.toggle('hidden', !isAuth || !wantsDns || dnsAccess);
  };
  $('.cond-auth', node).addEventListener('change', node.syncDns);
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
  placeholder.textContent = t('action_choose');
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
    hint.textContent = def?.hint ?? t('action_chooseHint');
    node.classList.toggle('unchosen', !def);
    hint.classList.toggle('danger', !!def?.danger);
    node.syncTags();
  };
  type.addEventListener('change', sync);
  sync();

  $('.del-action', node).addEventListener('click', () => {
    // A rule with no action would do nothing but still scan every folder.
    if (container.querySelectorAll('.action').length <= 1) {
      flash(t('status_needsAction'), true);
      return;
    }
    node.remove();
  });

  container.append(node);
}

/**
 * `saved` is true only for a rule drawn from storage. The Run button runs the
 * stored rule, so a card that differs from it must be saved first: otherwise a
 * rule just switched from Delete to Tag would still delete.
 */
function renderRule(rule = {}, saved = false) {
  const node = $('#rule-template').content.firstElementChild.cloneNode(true);
  if (!saved) node.dataset.unsaved = 'true';
  const markUnsaved = (event) => {
    // The folder filter and the collapse arrow change the view, not the rule.
    if (event.target.closest('.folder-filter, .rule-collapse, .run-rule')) return;
    if (event.type === 'click' && !event.target.closest('button')) return;
    node.dataset.unsaved = 'true';
  };
  for (const type of ['input', 'change', 'click']) node.addEventListener(type, markUnsaved);
  $('.run-rule', node).addEventListener('click', () => runRuleNow(node));
  $('.rule-id', node).value = rule.id ?? crypto.randomUUID();
  $('.rule-name', node).value = rule.name ?? t('rule_newName');
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

  $('.rule-schedule-on', node).checked = rule.schedule?.enabled === true;
  $('.rule-cron', node).value = rule.schedule?.cron ?? '';
  $('.rule-schedule-on', node).addEventListener('change', () => {
    refreshSchedule(node);
    if ($('.rule-schedule-on', node).checked) $('.rule-cron', node).focus();
  });
  $('.rule-cron', node).addEventListener('input', () => refreshSchedule(node));
  refreshSchedule(node);

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

/**
 * Show or hide a rule's schedule fields, and say in plain words what the cron
 * expression means and when it next matches, so a user can check it without
 * knowing the syntax.
 */
function refreshSchedule(node) {
  const on = $('.rule-schedule-on', node).checked;
  $('.schedule-fields', node).classList.toggle('hidden', !on);
  if (!on) return;

  const text = $('.schedule-text', node);
  const cron = parseCron($('.rule-cron', node).value);
  text.classList.toggle('danger', !cron.ok);
  if (!cron.ok) {
    text.textContent = t('schedule_error', cron.error);
    $('.cron-help', node).href = 'https://crontab.guru/';
    return;
  }
  const next = nextRun(cron);
  text.textContent = next
    ? t('schedule_next', describeCron(cron), next.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
    : t('schedule_never', describeCron(cron));
  // Opens the same expression in the editor the link points to.
  $('.cron-help', node).href = `https://crontab.guru/#${cron.expression.replaceAll(' ', '_')}`;
}

/** The schedule a rule card holds, or null when it has none worth storing. */
function scheduleFrom(node) {
  const enabled = $('.rule-schedule-on', node).checked;
  const cron = $('.rule-cron', node).value.trim();
  return enabled || cron ? { enabled, cron } : null;
}

/** A one-line digest of a rule, shown while it is collapsed. */
function ruleSummary(node) {
  const conditions = [...node.querySelectorAll('.condition')].map((c) => {
    // A multi-field set is stored comma-joined; read it back as prose.
    const value = $('.cond-field', c).value;
    const field = fieldsLabel(value);
    const negate = $('.cond-negate', c).checked;
    const operator = $('.cond-op', c).value;
    // The operator's own text, before syncRow greyed or renamed it.
    const opOption = $('.cond-op', c).selectedOptions[0];
    const opLabel = opOption?.dataset.label ?? opOption?.textContent ?? operator;
    const op = negate ? t('summary_not', opLabel) : opLabel;
    if (value === AGE_FIELD) {
      const days = $('.cond-days', c).value || '?';
      return plural('summary_age', Number(days), field, op, days);
    }
    if (STATE_FIELDS.includes(value)) return stateLabel(value, operator);
    if (value === TAG_FIELD) return t(negate ? 'summary_notHasTag' : 'summary_hasTag', tagLabel(c.dataset.tagKey));
    if (value === PRIORITY_FIELD) {
      const level = $('.cond-priority', c).selectedOptions[0]?.textContent ?? $('.cond-priority', c).value;
      return t(negate ? 'summary_priorityIsNot' : 'summary_priorityIs', level);
    }
    if (value === AUTH_FIELD) {
      return t(negate ? 'summary_authNotPasses' : 'summary_authPasses', $('.cond-auth', c).value.toUpperCase());
    }
    if (operator === IN_ADDRESS_BOOK) {
      return t(negate ? 'summary_notInBook' : 'summary_inBook', field, bookLabel(c.dataset.bookId));
    }
    if (operator === NAME_SHOWS_OTHER_ADDRESS) {
      return t(negate ? 'summary_notNameShows' : 'summary_nameShows', field);
    }
    if (operator === DOMAIN_IN_LIST) {
      const { domains } = parseDomainList($('.cond-domains', c).value);
      return plural(negate ? 'summary_notInList' : 'summary_inList', domains.length, field, domains.length);
    }
    return t('summary_text', field, op, $('.cond-value', c).value);
  });

  const joiner = ` ${$('.rule-match', node).value === 'all' ? t('summary_and') : t('summary_or')} `;
  // Listed in execution order, not row order, so the digest matches what runs.
  const actions = orderActions(
    [...node.querySelectorAll('.action')].map((a) => ({
      type: $('.action-type', a).value,
      tagKey: a.dataset.tagKey,
    })),
  ).map((a) => {
    const def = ACTIONS_BY_ID[a.type];
    if (!def) return t('summary_noAction');
    return def.needsTag ? t('summary_tagAction', tagLabel(a.tagKey)) : def.label;
  });
  const folderCount = $('.rule-folders', node).selectedOptions.length;
  const subs = $('.rule-subfolders', node).checked;
  const where = plural(subs ? 'summary_foldersAndSubfolders' : 'summary_folders', folderCount, folderCount);
  const what = conditions.join(joiner) || t('summary_noConditions');

  const cron = $('.rule-schedule-on', node).checked ? parseCron($('.rule-cron', node).value) : null;
  const when = cron?.ok ? ` · ${describeCron(cron)}` : '';

  return `${what} → ${actions.join(' + ') || t('summary_noAction')} · ${where}${when}`;
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

/** What "Collapse all" did last, so the button knows which way to go next. */
let allCollapsed = false;

function setAllCollapsed(isCollapsed) {
  for (const node of rulesEl.querySelectorAll('.rule')) setCollapsed(node, isCollapsed);
  allCollapsed = isCollapsed;
  $('#toggle-all').textContent = isCollapsed ? t('options_expandAll') : t('options_collapseAll');
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
      rejected.push(t('reject_tagActionNoTag', ruleName));
      continue;
    }
    if (isTerminalAction(action)) {
      if (terminal) {
        rejected.push(t('reject_secondTerminal', ruleName, ACTIONS_BY_ID[action.type].label));
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
    const name = $('.rule-name', node).value.trim() || t('common_untitledRule');
    const actions = collectActions(node, name, rejected);
    return {
      id: $('.rule-id', node).value || crypto.randomUUID(),
      name,
      enabled: $('.rule-enabled', node).checked,
      match: $('.rule-match', node).value,
      folderIds: [...$('.rule-folders', node).selectedOptions].map((o) => o.value),
      includeSubfolders: $('.rule-subfolders', node).checked,
      ...(scheduleFrom(node) ? { schedule: scheduleFrom(node) } : {}),
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
          if (days === null) rejected.push(raw ? t('reject_ageDays', raw) : t('reject_ageDaysEmpty'));
        } else if (STATE_FIELDS.includes(condition.field)) {
          condition.negate = false;
        } else if (condition.field === TAG_FIELD) {
          // A missing tag is stored as-is and never matches (the matcher guards it).
          condition.tagKey = c.dataset.tagKey || '';
          if (!condition.tagKey) rejected.push(t('reject_tagConditionNoTag'));
        } else if (condition.field === PRIORITY_FIELD) {
          condition.value = $('.cond-priority', c).value;
        } else if (condition.field === AUTH_FIELD) {
          condition.value = $('.cond-auth', c).value;
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
        } else if (operator !== NAME_SHOWS_OTHER_ADDRESS) {
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
  logScheduleRuns: '#adv-log-schedule',
  showMenu: '#adv-show-menu',
  shortName: '#adv-short-name',
  newMailDelaySeconds: '#adv-new-mail-delay',
  catchUpEveryMinutes: '#adv-catchup-every',
  catchUpLookbackDays: '#adv-catchup-days',
  scanOverlapMinutes: '#adv-overlap',
  authOwnCheck: '#adv-auth-own',
  authDohServer: '#adv-auth-server',
  authPrefer: '#adv-auth-prefer',
  authTrustedServers: '#adv-auth-trusted',
};

function fillAdvanced(settings) {
  for (const [key, selector] of Object.entries(ADVANCED_INPUTS)) {
    const el = $(selector);
    if (el.type === 'checkbox') el.checked = settings[key] === true;
    else el.value = settings[key];
  }
  // The DNS server or the own check might have changed.
  return loadDnsAccess().then(refreshDnsRows);
}

/** Raw values straight from the inputs; settings.js does the clamping. */
function collectAdvanced() {
  const raw = {};
  for (const [key, selector] of Object.entries(ADVANCED_INPUTS)) {
    const el = $(selector);
    raw[key] = el.type === 'checkbox' ? el.checked : el.value.trim();
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
      .map(() => $('.rule-name', node).value.trim() || t('common_untitledRule')),
  );
}

async function save() {
  // Refuse rather than correct: dropping the row could leave a rule with no
  // action, and guessing one is exactly the mistake this check exists to stop.
  const unchosen = unchosenActions();
  if (unchosen.length > 0) {
    const names = formatList([...new Set(unchosen)].map((n) => t('common_quoted', n)), 'unit');
    for (const node of rulesEl.querySelectorAll('.rule')) {
      if (node.querySelector('.action.unchosen')) setCollapsed(node, false);
    }
    rulesEl.querySelector('.action.unchosen .action-type')?.focus();
    flash(t('status_notSavedNoAction', names), true);
    return;
  }

  // Refused for the same reason: a schedule that does not parse would leave the
  // rule on the default timer while the card says otherwise.
  const badSchedule = [...rulesEl.querySelectorAll('.rule')].find(
    (node) => $('.rule-schedule-on', node).checked && !parseCron($('.rule-cron', node).value).ok,
  );
  if (badSchedule) {
    setCollapsed(badSchedule, false);
    $('.rule-cron', badSchedule).focus();
    const name = $('.rule-name', badSchedule).value.trim() || t('common_untitledRule');
    flash(t('status_notSavedBadSchedule', name), true);
    return;
  }

  // An enabled rule without folders scans nothing, yet the card looks active.
  // A disabled one saves, so a draft can wait for its folders.
  const noFolders = [...rulesEl.querySelectorAll('.rule')].find(
    (node) => $('.rule-enabled', node).checked && $('.rule-folders', node).selectedOptions.length === 0,
  );
  if (noFolders) {
    setCollapsed(noFolders, false);
    $('.folder-filter', noFolders).focus();
    const name = $('.rule-name', noFolders).value.trim() || t('common_untitledRule');
    flash(t('status_notSavedNoFolder', name), true);
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
  for (const rule of collected.rules) renderRule(rule, true);
  $('#allowlist').value = collected.allowlist.join('\n');
  fillAdvanced(collected.advanced);

  // Address-book conditions are kept even when they cannot run yet, but the
  // user must be told, since a condition that never matches looks like a bug.
  const tagActions = collected.rules.flatMap((r) => r.actions.filter((a) => a.type === 'tag'));
  const bookConds = collected.rules.flatMap((r) => r.conditions.filter((c) => c.operator === IN_ADDRESS_BOOK));
  const knownBooks = new Set([ALL_ADDRESS_BOOKS, ...addressBooks.map((b) => b.id)]);
  const notes = [];
  if (bookConds.length > 0 && !bookAccess) {
    notes.push(t('status_noteBookAccess'));
  } else if (bookConds.some((c) => !knownBooks.has(c.addressBookId))) {
    notes.push(t('status_noteBookMissing'));
  }
  const tagConds = collected.rules.flatMap((r) => r.conditions.filter((c) => c.field === TAG_FIELD && c.tagKey));
  if (tagConds.length > 0 && tagAccess && tagConds.some((c) => !tags.some((tag) => tag.key === c.tagKey))) {
    notes.push(t('status_noteTagConditionMissing'));
  }
  // Tagging itself works without messagesTagsList; only the picker needs it.
  if (tagActions.length > 0 && tagAccess && tagActions.some((a) => !tags.some((tag) => tag.key === a.tagKey))) {
    notes.push(t('status_noteTagActionMissing'));
  }

  flash(
    [
      rejected.length > 0
        ? plural('status_savedWithCorrections', rejected.length, rejected.length, rejected.join('; '))
        : t('status_saved'),
      ...notes,
    ].join(' '),
    notes.length > 0,
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
    $('#diag-report').value = t('diag_buildFailed', e.message);
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
  flash(t('status_diagCopied'));
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
  flash(t('status_diagSaved', diagnosticsFilename(now)));
}

async function clearDiagnostics() {
  await messenger.runtime.sendMessage({ command: 'clearDiagnostics' });
  await refreshDiagnostics();
  flash(t('status_diagCleared'));
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
  flash(t('status_exported', exportFilename(now)));
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
    flash(t('status_importReadFailed', file.name, e.message), true);
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
    ? t('status_importDuplicates', formatList(duplicates.map((d) => t('status_importDuplicate', d.name, d.hash, d.matches)), 'unit'))
    : '';

  if (rules.length === 0) {
    const why = problems.join('; ') || (duplicates.length ? '' : t('status_importNoRules'));
    flash(
      [t('status_importNothingNew'), why ? t('status_importBecause', why) : '', dupeNote].filter(Boolean).join(' '),
      !duplicates.length,
    );
    return;
  }

  for (const rule of rules) renderRule(rule);
  if (allowlist?.length) $('#allowlist').value = allowlist.join('\n');
  if (intervalMinutes) $('#interval').value = intervalMinutes;
  if (advanced) fillAdvanced(advanced);

  const skipped = problems.length > 0 ? t('status_importSkipped', problems.join('; ')) : '';
  flash(
    [plural('status_imported', rules.length, rules.length), skipped, dupeNote].filter(Boolean).join(' '),
    problems.length > 0,
  );
}

async function runNow() {
  flash(t('status_running'));
  try {
    const res = await messenger.runtime.sendMessage({ command: 'runNow' });
    const affected = res?.affected ?? 0;
    flash(plural('status_runDone', affected, affected));
  } catch (e) {
    flash(t('status_runFailed', e.message), true);
  }
}

/** Run one saved rule on every message in its folders. */
async function runRuleNow(node) {
  const name = $('.rule-name', node).value.trim() || t('common_untitledRule');
  if (node.dataset.unsaved === 'true') {
    flash(t('status_saveBeforeRun', name), true);
    return;
  }
  if (!$('.rule-enabled', node).checked) {
    flash(t('status_ruleTurnedOff', name), true);
    return;
  }
  flash(t('status_runningRule', name));
  try {
    const res = await messenger.runtime.sendMessage({
      command: 'runNow',
      ruleId: $('.rule-id', node).value,
    });
    const affected = res?.affected ?? 0;
    flash(plural('status_ruleRunDone', affected, name, affected));
  } catch (e) {
    flash(t('status_runFailed', e.message), true);
  }
}

async function init() {
  await loadFolders();
  await loadAddressBooks();
  await loadTags();
  const { config } = await messenger.storage.local.get({ config: null });
  // Before the rules, because an authentication row reads the own check
  // setting and the DNS server access.
  await fillAdvanced(sanitizeAdvanced(config?.advanced).settings);
  for (const id of ['#adv-auth-own', '#adv-auth-server']) {
    $(id).addEventListener('change', () => loadDnsAccess().then(refreshDnsRows));
  }
  $('#interval').value = config?.intervalMinutes ?? 10;
  const rules = config?.rules?.length ? config.rules : [{}];

  // On a first visit with many rules, start collapsed: a folder multi-select
  // makes each card tall enough that a dozen rules cannot be scanned otherwise.
  const firstVisit = localStorage.getItem(COLLAPSED_KEY) === null;
  // The blank starter card of a fresh install is not in storage yet.
  for (const r of rules) renderRule(r, Boolean(config?.rules?.length));
  if (firstVisit && rules.length > 3) setAllCollapsed(true);

  $('#allowlist').value = (config?.allowlist ?? DEFAULT_ALLOWLIST).join('\n');
  $('#reset-allowlist').addEventListener('click', () => {
    $('#allowlist').value = [...DEFAULT_ALLOWLIST].join('\n');
    flash(t('status_allowlistRestored'));
  });

  $('#reset-advanced').addEventListener('click', () => {
    fillAdvanced(ADVANCED_DEFAULTS);
    flash(t('status_advancedRestored'));
  });

  $('#add-rule').addEventListener('click', () => renderRule({}));
  $('#toggle-all').addEventListener('click', () =>
    setAllCollapsed(!allCollapsed),
  );
  $('#save').addEventListener('click', () => save().catch((e) => flash(e.message, true)));
  $('#run-now').addEventListener('click', runNow);
  $('#export').addEventListener('click', () => {
    try {
      exportRules();
    } catch (e) {
      flash(t('status_exportFailed', e.message), true);
    }
  });
  $('#import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (event) => {
    const [file] = event.target.files ?? [];
    // Reset so re-picking the same file fires change again.
    event.target.value = '';
    if (file) importRules(file).catch((e) => flash(t('status_importFailed', e.message), true));
  });

  // Keep book rows honest if access is granted or revoked in the Add-ons Manager
  // while this page is open.
  const onPermissionsChanged = () =>
    Promise.all([
      loadAddressBooks().then(refreshBookRows),
      loadTags().then(refreshTagRows),
      loadDnsAccess().then(refreshDnsRows),
    ]);
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
      flash(t('status_diagSaveFailed', e.message), true);
    }
  });
  $('#diag-clear').addEventListener('click', () =>
    clearDiagnostics().catch((e) => flash(e.message, true)),
  );

  if (folders.length === 0) {
    flash(t('status_noFolders'), true);
  }
}

init().catch((e) => flash(e.message, true));
