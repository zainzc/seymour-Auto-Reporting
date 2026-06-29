function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryAfterMs(error) {
  const retryAfterHeader = error?.response?.headers?.['retry-after'];
  if (!retryAfterHeader) return null;

  const parsedSeconds = Number(retryAfterHeader);
  if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
    return parsedSeconds * 1000;
  }

  return null;
}

function isTransientError(error) {
  const status = error?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status <= 599) return true;

  const code = String(error?.code || '').trim().toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return Boolean(
    code === 'ECONNABORTED' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_ABORTED' ||
    (code === 'ERR_BAD_RESPONSE' && message.includes('stream has been aborted')) ||
    message.includes('stream has been aborted')
  );
}

async function retryWithBackoff(fn, options = {}) {
  const maxAttempts = options.maxAttempts || 5;
  const baseDelayMs = options.baseDelayMs || 400;
  const maxDelayMs = options.maxDelayMs || 8000;
  const shouldRetry = options.shouldRetry || isTransientError;
  const onRetry = options.onRetry || (() => {});

  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await fn();
    } catch (error) {
      attempt += 1;
      const retryable = shouldRetry(error);
      const isLastAttempt = attempt >= maxAttempts;

      if (!retryable || isLastAttempt) {
        throw error;
      }

      const retryAfterMs = getRetryAfterMs(error);
      const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
      const delayMs = Math.max(retryAfterMs || 0, exponentialDelay);

      onRetry({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}

module.exports = {
  sleep,
  isTransientError,
  retryWithBackoff
};
