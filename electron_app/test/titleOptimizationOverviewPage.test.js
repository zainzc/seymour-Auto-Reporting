const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization', name), 'utf8');

test('Overview renders the configuration command center regions', () => {
  const html = read('overview.html');
  for (const id of ['workspace-health','configuration-version','last-updated','maximum-title-length','synonym-enrichment','manual-override-protection','sku-requirement','active-configuration-items','configured-tabs','configuration-warnings','system-rule-count','coverage-rows','source-fields-preview','source-priority-preview','terminology-preview','safety-highlights','phase74-listings-table','phase74-test-ipns','phase74-max-listings','run-phase74','phase74-progress','phase74-status','phase74-summary']) assert.match(html, new RegExp(`id="${id}"`));
  for (const region of ['command-status','command-grid','coverage-panel','core-protections','phase74-runner','focused-previews']) assert.match(html, new RegExp(`class="[^"]*${region}`));
  assert.doesNotMatch(html, /Priority Issues|issues-panel/);
  assert.match(html, /Title Optimization Playground/);
  assert.match(html, /Airtable <strong>Item Title<\/strong> field/);
  assert.doesNotMatch(html, /summary-cards|dashboard-rail|card-kicker|compact-card/);
  assert.doesNotMatch(html, /Preferred Title Length|Test Playground|Generate Test Title|Current Title|Proposed Title/);
});

test('Overview renderer uses the read-only API, actual payload, and owning-tab navigation', () => {
  const html = read('overview.html');
  const script = read('overview.js');
  assert.match(script, /titleOptimizationOverviewAPI\.load/);
  assert.match(script, /data\.previews\.sourceFields/);
  assert.match(script, /data\.sections/);
  assert.match(script, /phase74API\.getConfig/);
  assert.match(script, /phase74API\.run/);
  assert.match(script, /phase74API\.onProgress/);
  assert.match(script, /toLocaleString/);
  assert.doesNotMatch(script, /titleOptimizationOverviewAPI\.(save|delete|toggle|update|create)\s*\(/i);
  assert.doesNotMatch(html, /Add Rule|Save Rule|Edit Rule|Delete Rule/);
  for (const name of ['source-fields.html','source-priority.html','terminology-rules.html','synonyms.html','prefix-rules.html','restricted-terms.html','category-rules.html','title-structure.html','flag-reasons.html','system-rules.html']) {
    assert.match(html, new RegExp(`data-navigate="${name.replace('.', '\\.')}"`));
    assert.match(read(name), /data-navigate="overview\.html"[^>]*>Overview/);
  }
});

test('Overview styles preserve a full-width command layout, equal previews, focus, and responsive stacking', () => {
  const css = read('overview.css');
  assert.match(css, /\.command-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(css, /\.preview-panel\s*\{[^}]*display:\s*flex[^}]*min-height:/s);
  assert.match(css, /\.preview-panel \.preview-table\s*\{[^}]*flex:\s*1/s);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media\s*\(max-width:/);
  assert.match(css, /overflow-x:\s*auto/);
});

test('Overview uses the same visual tokens and typography as the other Title Optimization tabs', () => {
  const css = read('overview.css');
  assert.match(css, /@import url\("source-fields\.css"\)/);
  assert.match(css, /\.command-status\s*\{[^}]*border:\s*1px solid var\(--color-border\)[^}]*background:\s*var\(--color-surface\)[^}]*box-shadow:\s*var\(--shadow-sm\)/s);
  assert.match(css, /\.command-status span\s*\{[^}]*color:\s*var\(--color-muted\)[^}]*font-size:\s*12px/s);
  assert.match(css, /\.panel-heading h2\s*\{[^}]*color:\s*var\(--color-text\)[^}]*font-size:\s*20px/s);
  assert.match(css, /\.coverage-table th,\s*\.preview-table th\s*\{[^}]*background:\s*#f5f8fc[^}]*color:\s*var\(--slate-800\)/s);
  assert.match(css, /\.open-button\s*\{[^}]*border:\s*1px solid var\(--color-border\)[^}]*background:\s*var\(--slate-50\)[^}]*color:\s*var\(--color-primary\)/s);
  assert.doesNotMatch(css, /#111827|#4b5563|#d1d5db|#e5e7eb|font-weight:800/);
  assert.doesNotMatch(css, /text-transform:uppercase/);
});

test('Overview contains no screenshot sample data or rule-editing controls', () => {
  const joined = [read('overview.html'), read('overview.js')].join('\n');
  for (const fake of ['56 active','1554743','Mazda MPV','Fuse Box Engine Bay']) assert.doesNotMatch(joined, new RegExp(fake, 'i'));
  assert.doesNotMatch(joined, /Add Rule|Save Rule|Edit Rule|Delete Rule/);
  assert.equal((read('overview.html').match(/<(?:input|textarea)\b/g) || []).length, 3);
});
