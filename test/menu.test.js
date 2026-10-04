/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MENU_HARVEST,
  MENU_ROOT,
  MENU_RUN_ALL,
  MENU_RUN_RULE,
  menuItems,
  menuTitle,
  ruleIdFromMenuItem,
  runnableRules,
} from '../src/menu.js';

const rules = [
  { id: 'a1', name: 'Banks', enabled: true },
  { id: 'b2', name: '  ', enabled: true },
  { id: 'c3', name: 'Off', enabled: false },
  { name: 'Not saved yet' },
];

test('runnableRules keeps saved rules that are turned on', () => {
  assert.deepEqual(runnableRules(rules), [
    { id: 'a1', name: 'Banks' },
    { id: 'b2', name: 'Untitled rule' },
  ]);
  assert.deepEqual(runnableRules(undefined), []);
});

test('the menu has one parent with three entries, then one entry per rule', () => {
  const items = menuItems(rules);
  assert.deepEqual(items.map((i) => i.title), [
    'Folder Filter Scheduler',
    'Add spam domains',
    'Run all rules now',
    'Run a rule',
    'Banks',
    'Untitled rule',
  ]);
  assert.equal(items[0].parentId, undefined);
  for (const id of [MENU_HARVEST, MENU_RUN_ALL, MENU_RUN_RULE]) {
    assert.equal(items.find((i) => i.id === id).parentId, MENU_ROOT);
  }
  assert.deepEqual(items.slice(4).map((i) => i.parentId), [MENU_RUN_RULE, MENU_RUN_RULE]);
  assert.equal(items[3].enabled, true);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
});

test('a parent always comes before its children', () => {
  const seen = new Set();
  for (const item of menuItems(rules)) {
    if (item.parentId) assert.ok(seen.has(item.parentId), item.id);
    seen.add(item.id);
  }
});

test('"Run a rule" is turned off when no rule can run', () => {
  const items = menuItems([{ id: 'c3', name: 'Off', enabled: false }]);
  assert.equal(items.length, 4);
  assert.equal(items.find((i) => i.id === MENU_RUN_RULE).enabled, false);
});

test('a rule entry maps back to its rule id, and other items to null', () => {
  const [banks] = menuItems(rules).slice(4);
  assert.equal(ruleIdFromMenuItem(banks.id), 'a1');
  for (const id of [MENU_ROOT, MENU_HARVEST, MENU_RUN_ALL, MENU_RUN_RULE, undefined, 7]) {
    assert.equal(ruleIdFromMenuItem(id), null);
  }
});

test('menuTitle doubles an ampersand and cuts a long name', () => {
  assert.equal(menuTitle('Tom & Jerry'), 'Tom && Jerry');
  const long = menuTitle('x'.repeat(200));
  assert.equal(long.length, 60);
  assert.ok(long.endsWith('…'));
});
