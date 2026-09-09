const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('all primary application screens use a 1280px maximum shell width', () => {
  const primaryPages = [
    ['../src/renderer/pages/main-dashboard.html', /max-width:\s*1280px/],
    ['../src/renderer/pages/milestone1/index.html', /max-width:\s*1280px/],
    ['../src/renderer/pages/milestone1/powerlink-sheets.html', /width:\s*min\(1280px,\s*calc\(100vw - 32px\)\)/],
    ['../src/renderer/pages/milestone1/phase2-master-parts.html', /width:\s*min\(1280px,\s*calc\(100vw - 32px\)\)/],
    ['../src/renderer/pages/milestone1/phase5-batch-approval.html', /width:\s*min\(1280px,\s*calc\(100vw - 32px\)\)/],
    ['../src/renderer/pages/milestone11/index.html', /max-width:\s*1280px/],
    ['../src/renderer/pages/title-optimization/source-fields.css', /\.workspace-shell\s*\{\s*max-width:\s*1280px/]
  ];

  for (const [relativePath, expectedWidth] of primaryPages) {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    assert.match(source, expectedWidth, relativePath);
  }
});
