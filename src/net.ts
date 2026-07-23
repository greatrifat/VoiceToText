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

/**
 * Raised when an attempt outlived its deadline. Distinct from a transport error
 * because it is deliberately not retried here — see `timeoutMs` below.
 */
export class TimeoutError extends Error {}

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
    /**
     * Abort an attempt that outlives this many milliseconds.
     *
     * React Native builds its OkHttp client with connect, read and write
     * timeouts all set to zero — meaning no timeout at all. A connection that
     * dies silently mid-request (radio handoff, Doze with the screen off, an
     * idle upload dropped by carrier NAT) therefore leaves the fetch waiting on
     * bytes that never arrive, indefinitely. Nothing is thrown, so a caller with
     * its own fallback is never told to move on: the app looks like it is still
     * working when in fact it is stuck for good.
     *
     * Omitted means no deadline, which is right for calls that are expected to
     * be short and whose failure the user is waiting on interactively.
     */
    timeoutMs?: number;
  }
): Promise<Response> {
  const retryServerErrors = options?.retryServerErrors ?? true;
  const timeoutMs = options?.timeoutMs;
  let lastError: unknown;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const controller = timeoutMs ? new AbortController() : null;
    const timer =
      controller && timeoutMs
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

    try {
      const response = await fetch(
        url,
        controller ? { ...init, signal: controller.signal } : init
      );
      if (retryServerErrors && retriableStatus(response.status) && attempt < ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
      return response;
    } catch (err) {
      // A deadline is not retried in place. The wait has already been spent, and
      // a second full one would double the worst case before the caller's own
      // fallback — the next model, the next key — ever got a turn.
      if (controller?.signal.aborted) {
        throw new TimeoutError(`No response within ${Math.round(timeoutMs! / 1000)}s`);
      }

      // A thrown fetch is a transport failure — DNS, no route, connection reset.
      lastError = err;
      if (attempt < ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt]);
        continue;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? 'Network request failed'));
}
