const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', name), 'utf8');

test('Prefix Rules is reachable from all existing Title Optimization tabs', () => {
  for (const name of ['source-fields.html', 'source-priority.html', 'terminology-rules.html', 'synonyms.html']) {
    assert.match(read(name), /data-navigate="prefix-rules\.html"[^>]*>Prefix Rules/);
  }
});

test('Prefix Rules page uses existing shell, full-width table, and popup editor', () => {
  const html = read('prefix-rules.html');
  const css = read('prefix-rules.css');
  assert.match(html, /class="workspace-shell"/);
  assert.match(html, /class="workspace-navigation"/);
  assert.match(html, /id="prefix-editor"/);
  assert.match(html, /id="approved-term-chips"/);
  assert.match(html, /How Prefix Rules Work/);
  assert.doesNotMatch(html, /<th[^>]*>(Origin|Priority)<\/th>|sidebar/);
  for (const label of ['Prefix', 'Approved Part Terms', 'Special Rule / Note', 'Enabled', 'Actions']) assert.match(html, new RegExp(`<th[^>]*>${label}<\\/th>`));
  assert.match(html, /data-navigate="restricted-terms\.html"[^>]*>Restricted Terms/);
  for (const tab of ['Overview', 'Category Rules', 'Title Structure', 'Flag Reasons', 'System Rules']) assert.match(html, new RegExp(`<button[^>]*disabled[^>]*>${tab}<\\/button>`));
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /overflow-y:\s*auto/);
});
