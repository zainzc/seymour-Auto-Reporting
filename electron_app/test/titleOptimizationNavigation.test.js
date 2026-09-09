const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('dashboard navigation opens Title Optimization without changing existing workspace routes', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/main-dashboard.html'), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n');
  const context = { window: { location: { href: '' }, api: {} }, confirm: () => false, alert: () => {} };
  vm.createContext(context);
  vm.runInContext(script, context);

  context.goToTitleOptimization();
  assert.equal(context.window.location.href, 'title-optimization/source-fields.html');
  context.goToMilestone1();
  assert.equal(context.window.location.href, 'milestone1/index.html');
  context.goToReporting();
  assert.equal(context.window.location.href, 'milestone11/index.html');
});
