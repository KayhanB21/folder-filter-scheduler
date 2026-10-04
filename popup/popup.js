/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { runnableRules } from '../src/menu.js';

const $ = (selector) => document.querySelector(selector);

// The theme chosen on the options page, which shares this origin's storage.
const theme = localStorage.getItem('ffs.theme');
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;

const status = $('#status');

function say(text, isError = false) {
  status.textContent = text;
  status.classList.toggle('danger', isError);
}

/** Run every rule, or one rule when given its id, and report the result here. */
async function run(label, ruleId) {
  const buttons = [...document.querySelectorAll('#run-all, #rule-list button')];
  for (const button of buttons) button.disabled = true;
  say(`Running ${label}…`);
  try {
    const res = await messenger.runtime.sendMessage({ command: 'runNow', ...(ruleId ? { ruleId } : {}) });
    say(`Done. ${res?.affected ?? 0} message(s) affected.`);
  } catch (e) {
    say(`Run failed: ${e.message}`, true);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

async function init() {
  const { config } = await messenger.storage.local.get({ config: null });
  const rules = runnableRules(config?.rules);
  const list = $('#rule-list');
  for (const rule of rules) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = rule.name;
    button.title = rule.name;
    button.addEventListener('click', () => run(`“${rule.name}”`, rule.id));
    list.append(button);
  }
  $('#no-rules').hidden = rules.length > 0;
  $('#run-all').disabled = rules.length === 0;

  $('#run-all').addEventListener('click', () => run('all rules'));
  $('#open-options').addEventListener('click', async () => {
    await messenger.runtime.openOptionsPage();
    window.close();
  });
}

init().catch((e) => say(`Could not load the rules: ${e.message}`, true));
