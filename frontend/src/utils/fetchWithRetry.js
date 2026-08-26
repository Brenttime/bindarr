// Fetch a local API resource with bounded retries for transient failures.
// Authentication/validation failures return immediately; callers still decide
// how to present a final non-2xx response.
function abortError(signal) {
  return signal?.reason || new DOMException('Aborted', 'AbortError');
}

function waitForRetry(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError(signal));
    }, { once: true });
  });
}

export async function fetchWithRetry(input, init = {}, policy = {}) {
  const attempts = Math.max(1, policy.attempts || 3);
  const baseDelayMs = Math.max(0, policy.baseDelayMs ?? 100);
  const fetchImpl = policy.fetchImpl || fetch;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(input, init);
      const transientStatus = response.status === 429 || response.status >= 500;
      if (!transientStatus || attempt === attempts - 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (error?.name === 'AbortError' || init.signal?.aborted) throw error;
      lastError = error;
      if (attempt === attempts - 1) throw error;
    }
    await waitForRetry(baseDelayMs * (2 ** attempt), init.signal);
  }

  throw lastError || new Error('Request failed');
}
