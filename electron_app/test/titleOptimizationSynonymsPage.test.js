const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', name), 'utf8');

test('Synonyms opens inside the existing workspace and exposes Flag Reasons', () => {
  for (const name of ['source-fields.html', 'source-priority.html', 'terminology-rules.html']) {
    assert.match(read(name), /data-navigate="synonyms\.html"[^>]*>Synonyms/);
  }
  const html = read('synonyms.html');
  assert.match(html, /class="workspace-shell"/);
  assert.match(html, /class="workspace-navigation"/);
  assert.match(html, /class="active"[^>]*aria-current="page"[^>]*>Synonyms/);
  assert.doesNotMatch(html, /class="[^"]*sidebar/);
  assert.match(html, /data-navigate="prefix-rules\.html"[^>]*>Prefix Rules/);
  assert.match(html, /data-navigate="restricted-terms\.html"[^>]*>Restricted Terms/);
  assert.match(html, /data-navigate="category-rules\.html"[^>]*>Category Rules/);
  assert.match(html, /data-navigate="title-structure\.html"[^>]*>Title Structure<\/button>/);
  assert.match(html, /data-navigate="flag-reasons\.html"[^>]*>Flag Reasons/);
  assert.match(html, /data-navigate="system-rules\.html"[^>]*>System Rules/);
  assert.match(html, /<button[^>]*disabled[^>]*>Overview<\/button>/);
});

test('Synonyms shows a full-width table and popup-only editor without internal metadata', () => {
  const html = read('synonyms.html');
  const css = read('synonyms.css');
  for (const label of ['Primary Term', 'Approved Synonyms', 'Condition', 'Applies To', 'Enabled', 'Actions']) {
    assert.match(html, new RegExp(`<th[^>]*>${label}<\\/th>`));
  }
  assert.doesNotMatch(html, /<th[^>]*>(Priority|Origin)<\/th>|id="priority"/);
  assert.match(html, /id="master-enabled"/);
  assert.match(html, /id="synonym-editor"/);
  assert.match(html, /id="synonym-input"/);
  assert.match(html, /id="synonym-chips"/);
  assert.match(html, /How Synonym Enrichment Works/);
  assert.match(html, /confirmed FRONT half-shaft/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /overflow-y:\s*auto/);
});
