const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function executeInlineScripts(relativePath) {
  const html = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n');
  const context = { window: { location: { href: '' }, api: {} }, confirm: () => false, alert: () => {} };
  vm.createContext(context);
  vm.runInContext(script, context);
  return { context, html };
}

test('Milestone 1 navigation opens Title Optimization without changing dashboard workspace count', () => {
  const milestone = executeInlineScripts('../src/renderer/pages/milestone1/index.html');
  milestone.context.goToTitleOptimization();
  assert.equal(milestone.context.window.location.href, '../title-optimization/source-fields.html');

  const dashboard = executeInlineScripts('../src/renderer/pages/main-dashboard.html');
  assert.equal((dashboard.html.match(/class="workspace-card"/g) || []).length, 2);
  dashboard.context.goToMilestone1();
  assert.equal(dashboard.context.window.location.href, 'milestone1/index.html');
  dashboard.context.goToReporting();
  assert.equal(dashboard.context.window.location.href, 'milestone11/index.html');
});

test('all Milestone 1 workspace navigation bars include Title Optimization', () => {
  const pages = [
    '../src/renderer/pages/milestone1/powerlink-sheets.html',
    '../src/renderer/pages/milestone1/phase2-master-parts.html',
    '../src/renderer/pages/milestone1/phase5-batch-approval.html'
  ];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
    assert.match(html, /Title Optimization Workspace/);
    assert.match(html, /\.\.\/title-optimization\/source-fields\.html/);
  }

  const titlePage = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.html'), 'utf8');
  assert.match(titlePage, /data-navigate="\.\.\/milestone1\/index\.html"/);
});
