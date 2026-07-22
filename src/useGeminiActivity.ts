import { useEffect, useState } from 'react';

import { onGeminiAttempt, type GeminiAttempt } from './gemini';

/**
 * Phrases one attempt for the processing checklist. The failures are worth
 * spelling out rather than collapsing into "retrying": they mean different
 * things and lead to different fixes — a quota wait, a key from another
 * account, or simply trying again in a minute.
 */
function describe(attempt: GeminiAttempt): string {
  const key = attempt.keyCount > 1 ? ` · key ${attempt.keyNumber}/${attempt.keyCount}` : '';

  switch (attempt.outcome) {
    case 'trying':
      return `${attempt.model}${key}`;
    case 'ok':
      return `${attempt.model}${key} answered`;
    case 'quota':
      return `${attempt.model} out of quota — next model`;
    case 'unavailable':
      return `${attempt.model} unavailable for this key — next model`;
    case 'busy':
      return `${attempt.model} busy — next model`;
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
