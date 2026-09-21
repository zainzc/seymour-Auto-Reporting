const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', name), 'utf8');

test('Category Rules is reachable from all six previously implemented tabs', () => {
  for (const name of ['source-fields.html', 'source-priority.html', 'terminology-rules.html', 'synonyms.html', 'prefix-rules.html', 'restricted-terms.html']) {
    assert.match(read(name), /data-navigate="category-rules\.html"[^>]*>Category Rules/);
  }
});

test('Category Rules page uses existing shell popup table filters and exposes Flag Reasons', () => {
  const html = read('category-rules.html'), css = read('category-rules.css'), script = read('category-rules.js');
  assert.match(html, /class="workspace-shell"/); assert.match(html, /class="workspace-navigation"/);
  assert.match(html, /class="active"[^>]*aria-current="page"[^>]*>Category Rules/);
  assert.match(html, /id="category-editor"/); assert.match(html, /id="reference-filter"/);
  assert.match(html, /id="prefix-chips"/); assert.match(html, /id="series-chips"/); assert.match(html, /id="detail-chips"/);
  assert.match(html, /How Category Rules Work/); assert.doesNotMatch(html, /sidebar|permanent right-side/i);
  for (const label of ['Category', 'Prefix / Series', 'Important Verified Details', 'Enabled', 'Actions']) assert.match(html, new RegExp(`<th[^>]*>${label}<\\/th>`));
  assert.match(html, /data-navigate="title-structure\.html"[^>]*>Title Structure<\/button>/);
  assert.match(html, /data-navigate="flag-reasons\.html"[^>]*>Flag Reasons/);
  for (const tab of ['Overview', 'System Rules']) assert.match(html, new RegExp(`<button[^>]*disabled[^>]*>${tab}<\/button>`));
  assert.match(css, /overflow-x:\s*hidden/); assert.match(css, /overflow-y:\s*auto/);
  assert.match(script, /titleOptimizationCategoryRulesAPI/); assert.doesNotMatch(script, /configStore/);
});

test('Category Rules popup exposes accessible list entry and detail reorder controls', () => {
  const html = read('category-rules.html'), script = read('category-rules.js');
  for (const id of ['prefix-input', 'series-input', 'detail-input']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(script, /aria-label="Move .* up"/); assert.match(script, /aria-label="Move .* down"/);
  assert.match(script, /beforeunload/); assert.match(script, /discard-changes-dialog/); assert.match(script, /delete-rule-dialog/);
});
