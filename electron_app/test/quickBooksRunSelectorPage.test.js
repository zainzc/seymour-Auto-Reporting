const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/milestone11/index.html'), 'utf8');

test('QuickBooks overview provides an accessible day and execution selector', () => {
  assert.match(html, /id="qb-run-day-select"/);
  assert.match(html, /<label[^>]*for="qb-run-day-select"/);
  assert.match(html, /id="qb-run-options"/);
  assert.match(html, /aria-pressed/);
  assert.match(html, /getOverview\(\{ selectedRunId \}\)/);
  assert.match(html, /selectQuickBooksRunDay/);
  assert.match(html, /selectQuickBooksRun/);
});

test('selected execution replaces historical success and failure cards', () => {
  assert.match(html, /Selected Run Details/);
  assert.doesNotMatch(html, /renderRunCard\('Last Successful Import'/);
  assert.doesNotMatch(html, /renderRunCard\('Last Failed Import'/);
});

test('webhook attempts are clearly labeled as global history', () => {
  assert.match(html, /Webhook Start History[^<]*All Runs/);
});

test('failed selection responses preserve the previously displayed overview', () => {
  assert.match(html, /if \(!result\?\.overview\) throw new Error/);
  assert.match(html, /renderQuickBooksOverview\(quickBooksOverviewPayload, \{[\s\S]*refreshError/);
});

test('automatic refresh preserves the exact selected Run ID', () => {
  const preservingCalls = html.match(/loadQuickBooksOverview\(quickBooksOverviewPayload\?\.overview\?\.selectedRun\?\.runId \|\| ''\)/g) || [];
  assert.equal(preservingCalls.length >= 2, true);
});

test('processing refresh keeps last successful rows for the same run when the request fails', () => {
  assert.match(html, /const previousBreakdown =/);
  assert.match(html, /loadQuickBooksProcessingBreakdown\([^\n]+previousBreakdown[^\n]+\)/);
  assert.match(html, /renderTransactionTable\(previousBreakdown\)/);
});

test('execution button group uses a semantic caption', () => {
  assert.match(html, /id="qb-run-options-label"[^>]*>Execution</);
  assert.match(html, /aria-labelledby="qb-run-options-label"/);
  assert.doesNotMatch(html, /<label>Execution<\/label>/);
});
