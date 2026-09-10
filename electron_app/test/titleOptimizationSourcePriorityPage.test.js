const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

test('Source Priority page uses the existing workspace shell without a sidebar', () => {
  const html = read('../src/renderer/pages/title-optimization/source-priority.html');

  assert.match(html, /class="[^"]*workspace-shell[^"]*"/);
  assert.match(html, /class="workspace-navigation"/);
  assert.doesNotMatch(html, /class="[^"]*sidebar/);
  assert.match(html, /<h2[^>]*>Source Priority<\/h2>/);
  assert.match(html, /Priority affects conflicting values only/);
  assert.match(html, /How Source Priority Works/);
});

test('Source Fields and Source Priority are enabled while unfinished tabs remain disabled', () => {
  const sourceFields = read('../src/renderer/pages/title-optimization/source-fields.html');
  const sourcePriority = read('../src/renderer/pages/title-optimization/source-priority.html');

  assert.match(sourceFields, /data-navigate="source-priority\.html"[^>]*>Source Priority/);
  assert.match(sourcePriority, /data-navigate="source-fields\.html"[^>]*>Source Fields/);
  assert.match(sourcePriority, /class="active"[^>]*aria-current="page"[^>]*>Source Priority/);
  for (const tab of ['Overview', 'Terminology Rules', 'Synonyms', 'Prefix Rules', 'Restricted Terms', 'Category Rules', 'Title Structure', 'Flag Reasons', 'System Rules']) {
    assert.match(sourcePriority, new RegExp(`<button[^>]*disabled[^>]*>${tab}<\\/button>`));
  }
});

test('priority table includes lock, drag, keyboard controls, save/reset, feedback, and dialogs', () => {
  const html = read('../src/renderer/pages/title-optimization/source-priority.html');
  const script = read('../src/renderer/pages/title-optimization/source-priority.js');

  assert.match(html, /id="priority-rows"/);
  assert.match(html, /id="reset-button"/);
  assert.match(html, /id="save-button"/);
  assert.match(html, /id="reset-priority-dialog"/);
  assert.match(html, /id="discard-changes-dialog"/);
  assert.match(script, /draggable="true"/);
  assert.match(script, /aria-label="Move .* up"/);
  assert.match(script, /aria-label="Move .* down"/);
  assert.match(script, /Locked/);
  assert.match(script, /dragstart/);
  assert.match(script, /controller\.drop/);
  assert.match(script, /beforeunload/);
});
