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
  assert.match(html, /getOverview\(\{ selectedRunRecordId \}\)/);
  assert.match(html, /selectQuickBooksRunDay/);
  assert.match(html, /selectQuickBooksRun/);
});

test('only the selected Airtable Run Log record button is active when retries share a Run ID', () => {
  assert.match(html, /run\.recordId === selectedRun\.recordId/);
  assert.match(html, /selectQuickBooksRun\('\$\{encodeURIComponent\(run\.recordId\)\}'\)/);
});

test('processing totals replace provisional Run Log summary counters', () => {
  assert.match(html, /id="qb-import-summary"/);
  assert.match(html, /id="qb-selected-run-imported"/);
  assert.match(html, /breakdown\.summary/);
  assert.match(html, /latestImportSummary =/);
  assert.match(html, /renderQuickBooksImportSummary/);
  assert.match(html, /selectedRunImportedTarget\.textContent = displayNumber\(latestImportSummary\.imported\)/);
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
  const preservingCalls = html.match(/loadQuickBooksOverview\(quickBooksOverviewPayload\?\.overview\?\.selectedRun\?\.recordId \|\| ''\)/g) || [];
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

test('Current Automation Status never mixes historical full-run fields with the selected execution', () => {
  const start = html.indexOf('<h4>Current Automation Status');
  const end = html.indexOf('<h4>Selected Run Details', start);
  const currentStatusCard = html.slice(start, end);

  assert.match(currentStatusCard, /Selected environment/);
  assert.match(currentStatusCard, /Active Run ID/);
  assert.doesNotMatch(currentStatusCard, /latestRun/);
  assert.doesNotMatch(currentStatusCard, /Latest run status|Latest Run ID|Batch ID|Total duration|Displayed execution/);
});

test('schedule settings expose independent controls for all three workflows', () => {
  for (const key of ['main', 'retry1', 'retry2']) {
    assert.match(html, new RegExp(`id="qb-schedule-${key}-enabled"`));
    assert.match(html, new RegExp(`id="qb-schedule-${key}-time"`));
    assert.match(html, new RegExp(`id="qb-schedule-${key}-next-run"`));
  }
  assert.match(html, /confirmQuickBooksRunNow\(workflowKey\)/);
  assert.match(html, /runNow\(workflowKey\)/);
});

test('QuickBooks schedule timestamps render in the supplied Eastern timezone', () => {
  const formatterStart = html.indexOf('function formatQuickBooksTimestamp');
  const formatterEnd = html.indexOf('function quickBooksBadgeClass', formatterStart);
  const formatter = html.slice(formatterStart, formatterEnd);
  assert.match(formatter, /timeZone:\s*timezone/);
});
