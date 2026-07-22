/**
 * Mobile networks fail transiently: DNS lookups drop during radio wake-ups and
 * WiFi/mobile handoffs, and upstream services return 503 under load. A single
 * attempt turns any of those into a failed meeting the user has to retry by
 * hand, so every outbound call goes through here instead of calling fetch.
 *
 * Deliberately narrow: only failures that a second attempt could plausibly fix
 * are retried. A bad key, a rejected request or an exhausted quota is answered
 * the same way every time, and retrying it just wastes the user's daily budget.
 */

const ATTEMPTS = 3;
const BACKOFF_MS = [1200, 4000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 429 is excluded on purpose — the caller handles it by switching model or key. */
function retriableStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options?: {
    /**
     * Retry 5xx in place. Off for callers that have their own fallback — Gemini
     * moves to the next model on an overload, and retrying the busy one three
     * times first re-uploads the whole recording each time and delays that move
     * by minutes. Transport errors are still retried either way: they fail fast
     * and cost nothing, and no fallback fixes a dropped radio.
     */
    retryServerErrors?: boolean;
  }
): Promise<Response> {
  const retryServerErrors = options?.retryServerErrors ?? true;
  let lastError: unknown;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, init);
      if (retryServerErrors && retriableStatus(response.status) && attempt < ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      return response;
    } catch (err) {
      // A thrown fetch is a transport failure — DNS, no route, connection reset.
      lastError = err;
      if (attempt < ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? 'Network request failed'));
}
