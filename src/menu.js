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

const PREFIX = 'folder-filter-scheduler';

export const MENU_ROOT = `${PREFIX}.root`;
export const MENU_HARVEST = `${PREFIX}.harvest-domains`;
export const MENU_RUN_ALL = `${PREFIX}.run-all`;
export const MENU_RUN_RULE = `${PREFIX}.run-rule`;
const MENU_RULE_PREFIX = `${MENU_RUN_RULE}.`;

const TITLE_MAX = 60;

export const FULL_NAME = 'Folder Filter Scheduler';
export const SHORT_NAME = 'FFS';

/** The name on the toolbar button and the right-click menu. */
export const displayName = (short) => (short === true ? SHORT_NAME : FULL_NAME);

/** Rules a manual run accepts: saved, with an id, and turned on. */
export function runnableRules(rules) {
  return (rules ?? [])
    .filter((rule) => typeof rule?.id === 'string' && rule.id && rule.enabled !== false)
    .map((rule) => ({ id: rule.id, name: String(rule.name ?? '').trim() || 'Untitled rule' }));
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
    { id: MENU_HARVEST, parentId: MENU_ROOT, title: 'Add spam domains', contexts },
    { id: MENU_RUN_ALL, parentId: MENU_ROOT, title: 'Run all rules now', contexts },
    { id: MENU_RUN_RULE, parentId: MENU_ROOT, title: 'Run a rule', contexts, enabled: runnable.length > 0 },
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
