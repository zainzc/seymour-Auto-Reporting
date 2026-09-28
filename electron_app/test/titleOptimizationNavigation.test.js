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

test('Milestone 1 restores Title Optimization without changing dashboard workspace count', () => {
  const milestone = executeInlineScripts('../src/renderer/pages/milestone1/index.html');
  assert.match(milestone.html, /Open Title Optimization Workspace/);
  milestone.context.goToTitleOptimization();
  assert.equal(milestone.context.window.location.href, '../title-optimization/source-fields.html');

  const dashboard = executeInlineScripts('../src/renderer/pages/main-dashboard.html');
  assert.equal((dashboard.html.match(/class="workspace-card"/g) || []).length, 2);
  dashboard.context.goToMilestone1();
  assert.equal(dashboard.context.window.location.href, 'milestone1/index.html');
  dashboard.context.goToReporting();
  assert.equal(dashboard.context.window.location.href, 'milestone11/index.html');
});

test('client-facing Milestone 1 navigation restores Title Optimization', () => {
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
});

test('Title Optimization pages remain available internally', () => {
  const titlePage = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.html'), 'utf8');
  assert.match(titlePage, /data-navigate="\.\.\/milestone1\/index\.html"/);
  assert.match(titlePage, /data-navigate="source-priority\.html"/);

  const priorityPage = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-priority.html'), 'utf8');
  assert.match(priorityPage, /data-navigate="\.\.\/milestone1\/index\.html"/);
  assert.match(priorityPage, /data-navigate="source-fields\.html"/);
});

test('all Milestone 1 workspaces use the shared 1280px desktop width', () => {
  const pages = [
    '../src/renderer/pages/milestone1/powerlink-sheets.html',
    '../src/renderer/pages/milestone1/phase2-master-parts.html',
    '../src/renderer/pages/milestone1/phase5-batch-approval.html'
  ];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(__dirname, page), 'utf8');
    assert.match(html, /width:\s*min\(1280px,\s*calc\(100vw - 32px\)\)/);
  }
  const titleCss = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-fields.css'), 'utf8');
  assert.match(titleCss, /\.workspace-shell\s*\{\s*max-width:\s*1280px/);
  const priorityCss = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/title-optimization/source-priority.css'), 'utf8');
  assert.match(priorityCss, /\.priority-workspace\s*\{\s*max-width:\s*1280px/);
});

test('Phase 7.4 uses the authoritative config-driven runtime without shadow UI', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/milestone1/phase2-master-parts.html'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '../src/services/phase74TitleDescriptionService.js'), 'utf8');

  assert.doesNotMatch(html, /titleOptimizationRuntimeShadow|Phase7\.4 Shadow|shadowFinalTitle/);
  assert.match(main, /createTitleOptimizationRuntimeConfigService/);
  assert.match(main, /titleOptimizationRuntimeLoadSnapshot:\s*loadTitleOptimizationRuntimeSnapshot/);
  assert.match(service, /runTitleOptimizationRuntime/);
  assert.doesNotMatch(service, /generateTitleAndDescription\(/);
  assert.doesNotMatch(service, /TITLE_OPTIMIZATION_RUNTIME_SHADOW_ENABLED/);
  assert.doesNotMatch(service, /phase74TitleRulesPrompt/);
  assert.match(service, /PHASE74_LOG_AI_PAYLOAD\s*\?\?\s*'true'/);
  assert.match(html, /<div class="form-group" hidden aria-hidden="true">\s*<label for="phase4-unified-title-rules-prompt">/);
  assert.match(html, /<section class="card" hidden aria-hidden="true">\s*<h2 class="card-title">Phase 7\.4 \(Title & Description\)<\/h2>/);
});
