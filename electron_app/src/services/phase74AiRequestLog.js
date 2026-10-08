const fs = require('fs');
const path = require('path');

function defaultLogDirectory() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return path.join(app.getPath('userData'), 'phase74-ai-logs');
    }
  } catch (_) {
    // Node tests and non-Electron runs use the local application directory.
  }
  return path.join(process.cwd(), 'phase74-ai-logs');
}

function createPhase74AiRequestLog({ directory = defaultLogDirectory(), now = new Date() } = {}) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, `phase74-ai-requests-${stamp}-${process.pid}.jsonl`);
  fs.writeFileSync(filePath, '', { flag: 'wx', mode: 0o600 });
  return {
    filePath,
    append({ event, attemptId, kind, listing, requestBody, responseBody, error, result }) {
      fs.appendFileSync(filePath, `${JSON.stringify({
        time: new Date().toISOString(),
        event,
        attemptId,
        kind,
        recordId: listing?.recordId || null,
        ipn: listing?.ipn || null,
        ...(event === 'request' ? { requestBody } : {}),
        ...(event === 'response' ? { responseBody } : {}),
        ...(event === 'error' ? { error } : {}),
        ...(event === 'result' ? { result } : {})
      })}\n`);
    }
  };
}

module.exports = { createPhase74AiRequestLog };
