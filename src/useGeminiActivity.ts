import { useEffect, useState } from 'react';

import { onGeminiAttempt, type GeminiAttempt } from './gemini';

/**
 * Phrases one attempt for the processing checklist. The failures are worth
 * spelling out rather than collapsing into "retrying": they mean different
 * things and lead to different fixes — a quota wait, a key from another project,
 * account, or simply trying again in a minute.
 */
const mb = (bytes?: number) => ((bytes ?? 0) / 1024 / 1024).toFixed(1);

function describe(attempt: GeminiAttempt): string {
  const key = attempt.keyCount > 1 ? ` · key ${attempt.keyNumber}/${attempt.keyCount}` : '';

  switch (attempt.outcome) {
    case 'uploading':
      // Upload progress, so a big recording going up looks like work rather than
      // a hang. Falls back to just the size before the first progress tick.
      return attempt.totalBytes
        ? `Uploading ${mb(attempt.sentBytes)} / ${mb(attempt.totalBytes)} MB${key}`
        : `Uploading audio${key}`;
    case 'trying':
      return `Transcribing · ${attempt.model}${key}`;
    case 'ok':
      return `${attempt.model}${key} answered`;
    case 'quota':
      return `${attempt.model} daily quota used on this key — continuing fallback`;
    case 'rate-limit':
      return `${attempt.model} temporarily rate-limited — continuing fallback`;
    case 'unavailable':
      return `${attempt.model} unavailable for this key — continuing fallback`;
    case 'busy':
      return `${attempt.model} busy — next model`;
    case 'timeout':
      // Named as a connection problem, because that is what it almost always
      // is — and it points at the fix, which is a better network, not a retry.
      return 'connection stalled — no response, retrying';
    case 'rejected':
      // With one key there is no next one to move to, so do not promise it.
      return attempt.keyCount > 1
        ? `key ${attempt.keyNumber} rejected — next key`
        : 'key rejected';
  }
}

/**
 * What Gemini is doing, or null when nothing is in flight.
 *
 * Two lines rather than one: the reason a model was abandoned is the useful
 * part, and it used to be overwritten a fraction of a second later by the next
 * "trying" line, so the walk looked unexplained. The elapsed counter is there
 * because transcription legitimately runs for minutes — without it a slow model
 * is indistinguishable from a hung one.
 */
export function useGeminiActivity(active: boolean): string | null {
  const [current, setCurrent] = useState<GeminiAttempt | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState(0);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) {
      setCurrent(null);
      setReason(null);
      return;
    }
    return onGeminiAttempt((attempt) => {
      if (attempt.outcome === 'trying') {
        setCurrent(attempt);
        setStartedAt(Date.now());
        setSeconds(0);
      } else if (attempt.outcome === 'uploading') {
        // A live phase like 'trying', but it fires repeatedly as bytes go up, so
        // the elapsed clock is only (re)started when the upload first begins.
        setCurrent((prev) => {
          if (prev?.outcome !== 'uploading') {
            setStartedAt(Date.now());
            setSeconds(0);
          }
          return attempt;
        });
      } else if (attempt.outcome === 'ok') {
        setCurrent(null);
      } else {
        setCurrent(null);
        setReason(describe(attempt));
      }
    });
  }, [active]);

  useEffect(() => {
    if (!active || !current) return;
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [active, current, startedAt]);

  if (!active) return null;

  const lines: string[] = [];
  if (current) {
    // Seconds only once it has been slow enough to be worth reassuring about.
    lines.push(`${describe(current)}${seconds >= 5 ? ` · ${seconds}s` : ''}`);
  }
  if (reason) lines.push(current ? `after ${reason}` : reason);
  return lines.length ? lines.join('\n') : null;
}
