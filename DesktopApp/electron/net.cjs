const RETRY_DELAYS = [1200, 4000];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, init = {}, options = {}) {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 120000;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if ([500, 502, 503, 504].includes(response.status) && attempt < attempts - 1) {
        await delay(RETRY_DELAYS[attempt] + Math.floor(Math.random() * 400));
        continue;
      }
      return response;
    } catch (error) {
      lastError = controller.signal.aborted
        ? new Error(`No response within ${Math.round(timeoutMs / 1000)} seconds.`)
        : error;
      if (attempt < attempts - 1) {
        await delay(RETRY_DELAYS[attempt] + Math.floor(Math.random() * 400));
        continue;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Network request failed.');
}

module.exports = { fetchWithRetry };
