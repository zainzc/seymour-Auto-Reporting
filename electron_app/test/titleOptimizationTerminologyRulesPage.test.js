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

test('Terminology Rules layout keeps the table full-width with vertical-only scrolling and labeled narrow rows', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/terminology-rules.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/terminology-rules.js'), 'utf8');
  assert.match(css, /\.terminology-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.terminology-table\s*\{[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto/);
  assert.match(css, /\.terminology-table table\s*\{[^}]*min-width:\s*0;[^}]*table-layout:\s*fixed/);
  assert.match(css, /@media\s*\(max-width:\s*\d+px\)[\s\S]*\.terminology-table td::before\s*\{[^}]*content:\s*attr\(data-label\)/);
  for (const label of ['Source Term', 'Action', 'Replacement Term', 'Condition', 'Applies To', 'Enabled', 'Priority', 'Actions']) {
    assert.match(renderer, new RegExp(`data-label="${label}"`));
  }
});

test('Add and Edit use a hidden modal editor instead of a persistent panel', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/terminology-rules.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/terminology-rules.js'), 'utf8');
  assert.match(html, /<dialog id="rule-editor"[^>]*aria-labelledby="editor-heading"/);
  assert.match(html, /id="close-rule"/);
  assert.match(renderer, /editorDialog\.showModal\(\)/);
  assert.match(renderer, /editorDialog\.close\(\)/);
  assert.match(renderer, /editorDialog\.addEventListener\('cancel'/);
});
