const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Terminology Rules page keeps existing shell and provides table, filters, editor, and guidance', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/terminology-rules.html'), 'utf8');
  assert.match(html, /class="workspace-shell"/);
  assert.match(html, /class="workspace-navigation"/);
  assert.doesNotMatch(html, /class="[^\"]*sidebar/);
  for (const id of ['rule-search', 'condition-filter', 'status-filter', 'refresh-button', 'add-button', 'rule-rows', 'rule-editor', 'source-term', 'action', 'replacement-term', 'condition', 'applies-to', 'priority', 'enabled', 'save-rule', 'cancel-rule']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /How Terminology Rules Work/);
  assert.match(html, /id="discard-changes-dialog"/);
  assert.match(html, /id="delete-rule-dialog"/);
  assert.doesNotMatch(html, /Power Window Motor|PW Motor|Assy|Frt/);
});
