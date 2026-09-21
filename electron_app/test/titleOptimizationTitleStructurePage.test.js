const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', name), 'utf8');

test('Title Structure uses its own aligned popup styling without visible Origin UI', () => {
  const html = read('title-structure.html');
  const css = read('title-structure.css');
  assert.match(html, /href="title-structure\.css"/);
  assert.doesNotMatch(html, /<th[^>]*>Origin<\/th>/);
  assert.doesNotMatch(html, /id="origin"/);
  assert.match(html, /class="structure-form-grid"/);
  assert.match(html, /class="segment-entry"/);
  assert.match(css, /\.structure-form-grid\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /max-height:/);
});

test('Title Structure follows the shared Title Optimization page hierarchy and toolbar pattern', () => {
  const html = read('title-structure.html');
  assert.match(html, /<header class="hero">/);
  assert.match(html, /<section class="workspace-status"/);
  assert.match(html, /id="last-updated"/);
  assert.match(html, /class="source-card terminology-card structure-card"/);
  assert.match(html, /<h2 id="structure-heading">Title Structure<\/h2>/);
  assert.match(html, /class="rules-toolbar"/);
  assert.match(html, /class="toolbar-spacer"/);
  assert.match(html, /id="rule-count"/);
  assert.match(html, /id="refresh" class="button secondary"/);
  assert.match(html, /id="add" class="button primary"/);
});

test('Title Structure popup follows the shared Add/Edit editor pattern', () => {
  const html = read('title-structure.html');
  const css = read('title-structure.css');
  assert.match(html, /class="rule-editor-dialog editor-card structure-editor"/);
  assert.match(html, /class="editor-intro"/);
  assert.doesNotMatch(html, /class="structure-editor-footer"/);
  assert.match(html, /class="editor-toggle"/);
  assert.match(html, /class="editor-actions"/);
  assert.match(css, /\.structure-editor\.rule-editor-dialog/);
  assert.match(css, /width:\s*min\(680px,/);
  assert.doesNotMatch(css, /\.structure-editor::backdrop/);
  assert.match(css, /\.segments-fieldset\s*\{[^}]*background:\s*var\(--color-surface\)/s);
});

test('Title Structure navigation uses the unsaved-change guard', () => {
  const html = read('title-structure.html');
  const script = read('title-structure.js');
  assert.match(html, /data-navigate="source-fields\.html"/);
  assert.match(script, /querySelectorAll\('\[data-navigate\]'\)/);
  assert.match(script, /canNavigateAway/);
  assert.match(script, /beforeunload/);
});
