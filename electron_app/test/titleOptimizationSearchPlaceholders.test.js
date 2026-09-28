const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGES = [
  'terminology-rules.html',
  'synonyms.html',
  'prefix-rules.html',
  'restricted-terms.html',
  'category-rules.html',
  'title-structure.html',
  'flag-reasons.html',
  'system-rules.html'
];

test('all Title Optimization search placeholders use encoding-safe ellipses', () => {
  for (const page of PAGES) {
    const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', page), 'utf8');
    const search = html.match(/<input[^>]*type="search"[^>]*>/)?.[0] || '';

    assert.notEqual(search, '', `${page} must expose a search input`);
    assert.match(search, /placeholder="[^"]*\.\.\."/, `${page} must use an ASCII-safe search placeholder`);
    assert.doesNotMatch(search, /â|Ã|…/, `${page} search placeholder must not contain encoding-sensitive characters`);
  }
});
