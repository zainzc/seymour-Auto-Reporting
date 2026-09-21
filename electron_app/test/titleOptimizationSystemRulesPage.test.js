const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', name), 'utf8');

test('System Rules page is read-only and navigation is enabled everywhere', () => {
  const html = read('system-rules.html');
  assert.match(html, /<h2[^>]*>System Rules<\/h2>/);
  assert.match(html, /System Managed/);
  assert.match(html, /Locked/);
  assert.match(html, /id="search"/);
  assert.match(html, /id="category"/);
  assert.doesNotMatch(html, /Add Rule|Edit Rule|Delete|type="checkbox"|configStore/);
  for (const name of ['source-fields.html','source-priority.html','terminology-rules.html','synonyms.html','prefix-rules.html','restricted-terms.html','category-rules.html','title-structure.html','flag-reasons.html']) {
    assert.match(read(name), /data-navigate="system-rules\.html"[^>]*>System Rules/);
  }
});
