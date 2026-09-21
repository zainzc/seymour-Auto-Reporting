const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', name), 'utf8');

test('Overview is enabled on all tabs and renders service-derived summary regions', () => {
  const html=read('overview.html'), script=read('overview.js');
  for(const id of ['configuration-status','configured-tabs','configuration-warnings','system-rule-count','section-grid','warning-list']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(html,/Title Optimization/);
  assert.doesNotMatch(html,/sidebar|Add Rule|Save/);
  assert.match(script,/titleOptimizationOverviewAPI/);
  assert.doesNotMatch(script,/configStore|10 of 10/);
  for(const name of ['source-fields.html','source-priority.html','terminology-rules.html','synonyms.html','prefix-rules.html','restricted-terms.html','category-rules.html','title-structure.html','flag-reasons.html','system-rules.html']) assert.match(read(name),/data-navigate="overview\.html"[^>]*>Overview/);
});
