const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPhase74AiRequestLog } = require('../src/services/phase74AiRequestLog');
const Phase4AiEvaluatorService = require('../src/services/phase4AiEvaluatorService');

test('Phase 7.4 writes exact AI request bodies with listing identity to a per-run JSONL file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase74-ai-log-'));
  try {
    const log = createPhase74AiRequestLog({ directory, now: new Date('2026-10-08T00:00:00Z') });
    const requestBody = { model: 'gpt-5.1', messages: [{ role: 'user', content: '{"part":"Switch"}' }] };
    log.append({ event: 'request', attemptId: 'test-1', kind: 'title-generation',
      listing: { recordId: 'rec123', ipn: '641-50611L' }, requestBody });
    log.append({ event: 'response', attemptId: 'test-1', kind: 'title-generation',
      listing: { recordId: 'rec123', ipn: '641-50611L' }, responseBody: { choices: [{ message: { content: '{"generatedTitle":"Switch"}' } }] } });
    log.append({ event: 'error', attemptId: 'test-2', kind: 'fitment-review',
      listing: { recordId: 'rec123', ipn: '641-50611L' }, error: { message: 'timeout', status: null } });
    log.append({ event: 'result', kind: 'runtime-result', listing: { recordId: 'rec123', ipn: '641-50611L' },
      result: { decision: { decision: 'NEEDS_REVIEW' }, output: { title: '', reviewStatus: 'Needs Review' } } });
    const rows = fs.readFileSync(log.filePath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(row => row.event), ['request', 'response', 'error', 'result']);
    assert.equal(rows[0].ipn, '641-50611L');
    assert.equal(rows[0].recordId, 'rec123');
    assert.deepEqual(rows[0].requestBody, requestBody);
    assert.equal(rows[1].attemptId, rows[0].attemptId);
    assert.equal(rows[1].responseBody.choices[0].message.content, '{"generatedTitle":"Switch"}');
    assert.deepEqual(rows[2].error, { message: 'timeout', status: null });
    assert.equal(rows[3].result.output.reviewStatus, 'Needs Review');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AI HTTP attempts emit paired request and response or error events', async () => {
  const events = [];
  const service = new Phase4AiEvaluatorService({ apiKey: 'test-key',
    onPhase74Request: event => events.push(event) });
  service.client.post = async () => ({ data: { choices: [{ message: { content: 'ok' } }], usage: { total_tokens: 10 } } });
  await service.postPhase74Logged('title-generation', { recordId: 'rec1', ipn: '641-1' }, { model: 'test' });
  assert.deepEqual(events.map(event => event.event), ['request', 'response']);
  assert.equal(events[0].attemptId, events[1].attemptId);
  assert.equal(events[1].responseBody.usage.total_tokens, 10);
  service.client.post = async () => { const error = new Error('timeout'); error.response = { status: 504 }; throw error; };
  await assert.rejects(service.postPhase74Logged('fitment-review', { ipn: '641-1' }, { model: 'test' }), /timeout/);
  assert.deepEqual(events.slice(2).map(event => event.event), ['request', 'error']);
  assert.equal(events[2].attemptId, events[3].attemptId);
  assert.deepEqual(events[3].error, { message: 'timeout', status: 504 });
});
