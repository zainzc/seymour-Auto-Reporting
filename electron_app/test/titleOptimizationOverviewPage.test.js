const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', name), 'utf8');

test('Overview renders the approved dense read-only dashboard regions', () => {
  const html = read('overview.html');
  for (const id of ['workspace-health','configuration-version','last-updated','maximum-title-length','synonym-enrichment','manual-override-protection','sku-requirement','active-configuration-items','configured-tabs','configuration-warnings','source-fields-preview','source-priority-preview','terminology-preview','synonyms-preview','prefix-preview','restricted-summary','category-summary','structure-summary','flag-summary','system-summary','warning-groups','safety-highlights']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /dashboard-main/);
  assert.match(html, /dashboard-rail/);
  assert.doesNotMatch(html, /Preferred Title Length|Test Playground|Generate Test Title|Current Title|Proposed Title/);
});

test('Overview renderer uses the read-only API, actual payload, and owning-tab navigation', () => {
  const html = read('overview.html');
  const script = read('overview.js');
  assert.match(script, /titleOptimizationOverviewAPI\.load/);
  assert.match(script, /data\.previews\.sourceFields/);
  assert.match(script, /data\.warningGroups/);
  assert.match(script, /toLocaleString/);
  assert.doesNotMatch(script, /\.(save|delete|toggle|update|create)\s*\(/i);
  assert.doesNotMatch(html, /Add Rule|Save Rule|Edit Rule|Delete Rule/);
  for (const name of ['source-fields.html','source-priority.html','terminology-rules.html','synonyms.html','prefix-rules.html','restricted-terms.html','category-rules.html','title-structure.html','flag-reasons.html','system-rules.html']) {
    assert.match(html, new RegExp(`data-navigate="${name.replace('.', '\\.')}"`));
    assert.match(read(name), /data-navigate="overview\.html"[^>]*>Overview/);
  }
});

test('Overview styles preserve dense hierarchy, bounded warnings, focus, and responsive stacking', () => {
  const css = read('overview.css');
  assert.match(css, /grid-template-columns:\s*minmax\(0,1fr\)\s+minmax\(/);
  assert.match(css, /\.warning-groups\s*\{[^}]*max-height:[^}]*overflow-y:\s*auto/s);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(max-width:/);
  assert.match(css, /overflow-x:\s*auto/);
});

test('Overview typography follows the shared system while content uses neutral black styling', () => {
  const css = read('overview.css');
  assert.match(css, /\.summary-card>span,\.card-kicker\{[^}]*font-size:12px/s);
  assert.match(css, /\.dashboard-card-header h2,\.section-heading h2\{[^}]*font-size:20px/s);
  assert.match(css, /\.preview-table table\{[^}]*font-size:12px/s);
  assert.match(css, /\.preview-table th\{[^}]*font-size:12px/s);
  assert.match(css, /\.preview-table th\{[^}]*color:#111827/s);
  assert.match(css, /\.summary-card>span,\.card-kicker\{[^}]*color:#111827/s);
  assert.match(css, /\.dashboard-card-header h2,\.section-heading h2\{[^}]*color:#111827/s);
  assert.match(css, /\.text-button\{[^}]*color:#111827/s);
  assert.doesNotMatch(css, /color:var\(--color-primary\)|color:var\(--color-accent\)|rgba\(37,131,232/);
  assert.doesNotMatch(css, /text-transform:uppercase/);
  assert.doesNotMatch(css, /#9fc9f5|#eef7ff|#fbfdff|#f4f9ff|#f8fbff/);
});

test('Overview contains no screenshot sample data or editable configuration controls', () => {
  const joined = [read('overview.html'), read('overview.js')].join('\n');
  for (const fake of ['56 active','1554743','Mazda MPV','Fuse Box Engine Bay']) assert.doesNotMatch(joined, new RegExp(fake, 'i'));
  assert.doesNotMatch(joined, /<input|<select|<textarea/);
});
