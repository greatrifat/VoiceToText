import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { processMeeting, type PipelineStage } from './pipeline';
import { useSettings } from './SettingsContext';

/**
 * Runs meetings' pipelines outside any one screen, so a retry started from the
 * History detail keeps going after that modal is closed and the user browses to
 * another recording. Without this the work was tied to the component that
 * awaited it: closing the detail lost the progress UI, and — because React tears
 * the component down — any state update it tried to make afterwards was wasted.
 *
 * Work runs one meeting at a time. Sequential rather than parallel on purpose:
 * the free-tier quota is small, and the per-attempt timing log listens to a
 * single global event stream, which two concurrent pipelines would scramble.
 *
 * The DB writes in `processMeeting` were always safe on their own; this only
 * lifts the *visible* progress up to a place that outlives the screen and
 * serialises the runs.
 */

/** 'queued' waits its turn; 'starting' covers the gap before the first stage. */
export type ProcStage = PipelineStage | 'starting' | 'queued';

type ProcessingContextValue = {
  /** Current stage of each queued/in-flight meeting; absence means "idle". */
  stages: Record<number, ProcStage>;
  /** Bumped whenever a meeting finishes, so lists can re-read the database. */
  version: number;
  isProcessing: (meetingId: number) => boolean;
  start: (meetingId: number) => void;
};

const ProcessingContext = createContext<ProcessingContextValue | null>(null);

export function ProcessingProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [stages, setStages] = useState<Record<number, ProcStage>>({});
  const [version, setVersion] = useState(0);

  const queue = useRef<number[]>([]);
  const running = useRef(false);
  // Kept in a ref so the queue runner always sees the latest keys/URLs without
  // being torn down and recreated mid-run.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const setStage = useCallback((meetingId: number, stage: ProcStage) => {
    setStages((prev) => ({ ...prev, [meetingId]: stage }));
  }, []);

  const runNext = useCallback(async () => {
    if (running.current) return;
    const meetingId = queue.current[0];
    if (meetingId === undefined) return;

    running.current = true;
    setStage(meetingId, 'starting');
    try {
      await processMeeting({
        meetingId,
        settings: settingsRef.current,
        onStage: (stage) => setStage(meetingId, stage),
      });
    } catch {
      // Recorded on the meeting as `lastError`; the list surfaces it.
    }

    queue.current.shift();
    setStages((prev) => {
      const next = { ...prev };
      delete next[meetingId];
      return next;
    });
    setVersion((v) => v + 1);
    running.current = false;
    runNext();
  }, [setStage]);

  const start = useCallback(
    (meetingId: number) => {
      if (queue.current.includes(meetingId)) return;
      queue.current.push(meetingId);
      setStages((prev) => ({ ...prev, [meetingId]: prev[meetingId] ?? 'queued' }));
      runNext();
    },
    [runNext]
  );

  const isProcessing = useCallback((meetingId: number) => meetingId in stages, [stages]);

  return (
    <ProcessingContext.Provider value={{ stages, version, isProcessing, start }}>
      {children}
    </ProcessingContext.Provider>
  );
}

export function useProcessing(): ProcessingContextValue {
  const value = useContext(ProcessingContext);
  if (!value) throw new Error('useProcessing must be used inside a ProcessingProvider');
  return value;
}
