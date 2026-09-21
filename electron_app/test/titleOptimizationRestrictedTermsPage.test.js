const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', name), 'utf8');

test('Restricted Terms is reachable from all existing implemented tabs', () => {
  for (const name of ['source-fields.html', 'source-priority.html', 'terminology-rules.html', 'synonyms.html', 'prefix-rules.html']) {
    assert.match(read(name), /data-navigate="restricted-terms\.html"[^>]*>Restricted Terms/);
  }
});

test('Restricted Terms page uses popup editor and responsive, vertically scrolling table', () => {
  const html = read('restricted-terms.html');
  const css = read('restricted-terms.css');
  assert.match(html, /class="workspace-shell"/);
  assert.match(html, /id="restricted-editor"/);
  assert.match(html, /id="scope-filter"/);
  assert.match(html, /How Restricted Terms Work/);
  for (const label of ['Term', 'Rule Type', 'Scope', 'Notes', 'Enabled', 'Actions']) assert.match(html, new RegExp(`<th[^>]*>${label}<\\/th>`));
  assert.doesNotMatch(html, /<th[^>]*>(Origin|Priority)<\/th>|sidebar/i);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /overflow-y:\s*auto/);
});
