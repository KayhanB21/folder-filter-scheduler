/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The right-click menu, as data.
 *
 * Pure and free of extension APIs, like matcher.js and cron.js. The background
 * script hands these items to `messenger.menus.create`, and the toolbar popup
 * lists the same rules, so both offer exactly the rules a run accepts.
 */

import { t } from './i18n.js';
import { addressesFromHeaderValue, splitMailbox } from './domains.js';
import { normalizeAddress } from './contacts.js';

const PREFIX = 'folder-filter-scheduler';

export const MENU_ROOT = `${PREFIX}.root`;
export const MENU_HARVEST = `${PREFIX}.harvest-domains`;
export const MENU_CREATE_RULE = `${PREFIX}.create-rule`;
export const MENU_RUN_ALL = `${PREFIX}.run-all`;
export const MENU_RUN_RULE = `${PREFIX}.run-rule`;
const MENU_RULE_PREFIX = `${MENU_RUN_RULE}.`;

const TITLE_MAX = 60;

export const FULL_NAME = t('extensionName');
export const SHORT_NAME = 'FFS';

/** The name on the toolbar button and the right-click menu. */
export const displayName = (short) => (short === true ? SHORT_NAME : FULL_NAME);

/** Rules a manual run accepts: saved, with an id, and turned on. */
export function runnableRules(rules) {
  return (rules ?? [])
    .filter((rule) => typeof rule?.id === 'string' && rule.id && rule.enabled !== false)
    .map((rule) => ({ id: rule.id, name: String(rule.name ?? '').trim() || t('common_untitledRule') }));
}

/**
 * A rule name as a menu title. A menu reads `&` as the mark for an access key,
 * so a literal one is doubled. A long name is cut so the menu stays narrow.
 */
export function menuTitle(name) {
  const text = String(name ?? '');
  const short = text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
  return short.replace(/&/g, '&&');
}

/**
 * Every menu item, parents before children, as arguments for `menus.create`.
 * With no rule to run, "Run a rule" is shown but turned off, so the menu keeps
 * its shape and the user sees why nothing is listed.
 */
export function menuItems(rules, contexts = ['message_list'], rootTitle = FULL_NAME) {
  const runnable = runnableRules(rules);
  return [
    { id: MENU_ROOT, title: rootTitle, contexts },
    { id: MENU_HARVEST, parentId: MENU_ROOT, title: t('common_addSpamDomains'), contexts },
    { id: MENU_CREATE_RULE, parentId: MENU_ROOT, title: t('menu_createRule'), contexts },
    { id: MENU_RUN_ALL, parentId: MENU_ROOT, title: t('common_runAllRulesNow'), contexts },
    { id: MENU_RUN_RULE, parentId: MENU_ROOT, title: t('menu_runARule'), contexts, enabled: runnable.length > 0 },
    ...runnable.map((rule) => ({
      id: `${MENU_RULE_PREFIX}${rule.id}`,
      parentId: MENU_RUN_RULE,
      title: menuTitle(rule.name),
      contexts,
    })),
  ];
}

/** The rule id behind a "Run a rule" entry, or null for any other item. */
export function ruleIdFromMenuItem(menuItemId) {
  const id = String(menuItemId ?? '');
  return id.startsWith(MENU_RULE_PREFIX) ? id.slice(MENU_RULE_PREFIX.length) : null;
}

/** Strip leading reply/forward prefixes (Re:, Fwd:, Fw:, Aw:) from a subject. */
function cleanSubject(subject) {
  return String(subject ?? '')
    .trim()
    .replace(/^(?:(?:re|fwd?|aw|sv|tr)\s*(?:\[\d+\])?:\s*)+/i, '')
    .trim();
}

/** Extract the canonical `<list.example.org>` identifier from a List-Id header. */
function extractListId(rawListId) {
  const text = String(rawListId ?? '').trim();
  if (!text) return { id: '', label: '' };
  const angle = /<([^>]+)>/.exec(text);
  if (angle) {
    const id = angle[1].trim();
    const label = text.slice(0, angle.index).trim().replace(/^["']|["']$/g, '').trim();
    return { id, label };
  }
  return { id: text, label: '' };
}

/**
 * Build an unsaved draft rule from a right-clicked message.
 *
 * Pre-fills the message's folder and chooses the strongest identifier available
 * (`List-Id` for mailing lists, otherwise `From`, otherwise `Subject`). Leaves
 * `actions` empty so the options page starts on "Choose an action…" and nothing
 * destructive is ever pre-selected.
 */
export function draftRuleFromMessage(messageHeader, headers = null, fallbackFolderId = null) {
  const folderId = messageHeader?.folder?.id ?? fallbackFolderId ?? null;
  const folderIds = folderId ? [String(folderId)] : [];

  const rawListId = Array.isArray(headers?.['list-id']) ? headers['list-id'][0] : '';
  const list = extractListId(rawListId);

  const rawFrom = (Array.isArray(headers?.from) && headers.from[0]) || messageHeader?.author || '';
  const fromAddresses = addressesFromHeaderValue(rawFrom).map(normalizeAddress).filter(Boolean);
  const fromAddress = fromAddresses[0] ?? '';
  const fromName = splitMailbox(rawFrom).name.replace(/^["']|["']$/g, '').trim();

  const subject = cleanSubject(
    (Array.isArray(headers?.subject) && headers.subject[0]) || messageHeader?.subject || '',
  );

  const conditions = [];
  let name = t('rule_newName');

  if (list.id) {
    conditions.push({ field: 'list-id', operator: 'contains', value: list.id, negate: false });
    name = list.label || list.id;
  } else if (fromAddress) {
    conditions.push({ field: 'from', operator: 'contains', value: fromAddress, negate: false });
    name = fromName || fromAddress;
  } else if (subject) {
    conditions.push({ field: 'subject', operator: 'contains', value: subject, negate: false });
    name = subject;
  } else {
    conditions.push({ field: 'from', operator: 'contains', value: '', negate: false });
  }

  return {
    name: name.length > 80 ? `${name.slice(0, 79)}…` : name,
    enabled: true,
    match: 'all',
    folderIds,
    includeSubfolders: false,
    conditions,
    actions: [],
  };
}
