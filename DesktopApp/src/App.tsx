import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cloud,
  Download,
  ExternalLink,
  FileAudio,
  FolderOpen,
  History,
  KeyRound,
  LoaderCircle,
  Mic,
  MonitorSpeaker,
  Pause,
  Play,
  Plus,
  Radio,
  RotateCcw,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { ApiKeyEntry, AppState, Meeting, ProcessingEvent, Settings } from './types';

type Page = 'record' | 'history' | 'settings';
type CaptureState = 'idle' | 'starting' | 'recording' | 'paused' | 'saving';

const emptySettings: Settings = { apiKeys: [], driveUrl: '', driveSecret: '', taskNoteUrl: '' };

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
  const rest = String(seconds % 60).padStart(2, '0');
  return hours ? `${String(hours).padStart(2, '0')}:${minutes}:${rest}` : `${minutes}:${rest}`;
}

function formatDate(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(value);
}

function statusLabel(status: Meeting['status']) {
  return ({
    saved: 'Saved', transcribing: 'Transcribing', summarizing: 'Summarizing',
    uploading: 'Saving to Drive', posting: 'Sending to TaskNote', done: 'Ready', error: 'Needs attention',
  } satisfies Record<Meeting['status'], string>)[status];
}

export default function App() {
  const [page, setPage] = useState<Page>('record');
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [version, setVersion] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, ProcessingEvent>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [recordingActive, setRecordingActive] = useState(false);

  const refreshMeetings = useCallback(async () => {
    const rows = await window.voiceDesktop.listMeetings();
    setMeetings(rows);
    return rows;
  }, []);

  useEffect(() => {
    window.voiceDesktop.getState()
      .then((state: AppState) => {
        setSettings(state.settings);
        setMeetings(state.meetings);
        setVersion(state.version);
      })
      .catch((error) => setNotice(errorMessage(error)))
      .finally(() => setLoading(false));
    return window.voiceDesktop.onProcessing((event) => {
      setProgress((current) => ({ ...current, [event.meetingId]: event }));
      if (event.stage === 'done' || event.stage === 'error') void refreshMeetings();
    });
  }, [refreshMeetings]);

  const selectedMeeting = meetings.find((meeting) => meeting.id === selectedId) || null;

  const processMeeting = useCallback(async (id: string) => {
    try {
      await window.voiceDesktop.processMeeting(id);
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      await refreshMeetings();
    }
  }, [refreshMeetings]);

  if (loading) {
    return <div className="boot"><LoaderCircle className="spin" size={28} /> Opening VoiceToText…</div>;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><AudioLines size={22} /></div><div><strong>VoiceToText</strong><span>Desktop</span></div></div>
        <nav aria-label="Primary navigation">
          <NavButton active={page === 'record'} live={recordingActive} icon={<Radio />} label={recordingActive ? 'Recording' : 'Record'} onClick={() => setPage('record')} />
          <NavButton active={page === 'history'} icon={<History />} label="History" badge={meetings.length || undefined} onClick={() => setPage('history')} />
          <NavButton active={page === 'settings'} icon={<SettingsIcon />} label="Settings" onClick={() => setPage('settings')} />
        </nav>
        <div className="sidebar-foot">
          <div className="privacy-note"><ShieldCheck size={17} /><span>Credentials encrypted with Windows</span></div>
          <small>Version {version}</small>
        </div>
      </aside>

      <main className="main">
        {notice && <div className="toast error"><CircleHelp size={18} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={16} /></button></div>}
        <div className={`page-slot ${page === 'record' ? 'visible' : 'hidden'}`} aria-hidden={page !== 'record'}>
          <RecordPage
            configured={settings.apiKeys.length > 0 && Boolean(settings.driveUrl)}
            onCaptureStateChange={setRecordingActive}
            onConfigure={() => setPage('settings')}
            onSaved={async (meeting) => {
              await refreshMeetings();
              setSelectedId(meeting.id);
              void processMeeting(meeting.id);
            }}
            progress={selectedId ? progress[selectedId] : undefined}
            onError={setNotice}
          />
        </div>
        {page === 'history' && (
          <HistoryPage
            meetings={meetings}
            taskNoteConfigured={Boolean(settings.taskNoteUrl.trim())}
            selectedId={selectedId}
            progress={progress}
            onSelect={setSelectedId}
            onRefresh={refreshMeetings}
            onRetry={processMeeting}
            onError={setNotice}
          />
        )}
        {page === 'settings' && (
          <SettingsPage
            initial={settings}
            onSaved={(value) => { setSettings(value); setNotice('Settings saved securely.'); }}
            onError={setNotice}
          />
        )}
      </main>

      {selectedMeeting && page !== 'history' && selectedMeeting.status === 'done' && (
        <button className="ready-float" onClick={() => setPage('history')}><Check size={17} /> {selectedMeeting.title}<ChevronRight size={16} /></button>
      )}
    </div>
  );
}

function NavButton({ active, live, icon, label, badge, onClick }: { active: boolean; live?: boolean; icon: React.ReactNode; label: string; badge?: number; onClick(): void }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{icon}<span>{label}</span>{live && <i className="nav-live" title="Recording in progress" />}{badge != null && <em>{badge}</em>}</button>;
}

function RecordPage({ configured, onConfigure, onSaved, onCaptureStateChange, progress, onError }: {
  configured: boolean;
  onConfigure(): void;
  onSaved(meeting: Meeting): void;
  onCaptureStateChange(active: boolean): void;
  progress?: ProcessingEvent;
  onError(message: string): void;
}) {
  const [captureState, setCaptureState] = useState<CaptureState>('idle');
  const [micEnabled, setMicEnabled] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [levels, setLevels] = useState({ system: 0, mic: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamsRef = useRef<MediaStream[]>([]);
  const contextRef = useRef<AudioContext | null>(null);
  const destinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micGainRef = useRef<GainNode | null>(null);
  const systemAnalyserRef = useRef<AnalyserNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micEnabledRef = useRef(true);
  const startedAtRef = useRef(0);
  const accumulatedRef = useRef(0);
  const intervalRef = useRef<number | null>(null);
  const animationRef = useRef<number | null>(null);

  useEffect(() => {
    micEnabledRef.current = micEnabled;
  }, [micEnabled]);

  useEffect(() => {
    onCaptureStateChange(['starting', 'recording', 'paused', 'saving'].includes(captureState));
  }, [captureState, onCaptureStateChange]);

  const stopMeters = () => {
    if (animationRef.current != null) cancelAnimationFrame(animationRef.current);
    setLevels({ system: 0, mic: 0 });
  };

  const cleanCapture = useCallback(() => {
    if (intervalRef.current != null) window.clearInterval(intervalRef.current);
    stopMeters();
    streamsRef.current.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    streamsRef.current = [];
    micStreamRef.current = null;
    micGainRef.current = null;
    systemAnalyserRef.current = null;
    micAnalyserRef.current = null;
    destinationRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    cleanCapture();
  }, [cleanCapture]);

  const finishCapture = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      if (recorder.state === 'recording') {
        accumulatedRef.current += Date.now() - startedAtRef.current;
      }
      setCaptureState('saving');
      recorder.stop();
    }
  }, []);

  const runMeters = () => {
    if (animationRef.current != null) cancelAnimationFrame(animationRef.current);
    const tick = () => {
      const average = (data: Uint8Array) => data.reduce((sum, value) => sum + value, 0) / data.length / 180;
      const systemAnalyser = systemAnalyserRef.current;
      const micAnalyser = micAnalyserRef.current;
      let system = 0;
      let mic = 0;
      if (systemAnalyser) {
        const data = new Uint8Array(systemAnalyser.frequencyBinCount);
        systemAnalyser.getByteFrequencyData(data);
        system = Math.min(1, average(data));
      }
      if (micAnalyser && micEnabledRef.current) {
        const data = new Uint8Array(micAnalyser.frequencyBinCount);
        micAnalyser.getByteFrequencyData(data);
        mic = Math.min(1, average(data));
      }
      setLevels({ system, mic });
      animationRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  const connectMicrophone = async (context: AudioContext, destination: MediaStreamAudioDestinationNode) => {
    if (micStreamRef.current && micGainRef.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
    });
    if (!stream.getAudioTracks().length) throw new Error('No microphone audio was available.');
    // The recording may have ended while the Windows permission dialog was open.
    if (contextRef.current !== context) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    streamsRef.current.push(stream);
    micStreamRef.current = stream;
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    gain.gain.value = micEnabledRef.current ? 1 : 0;
    source.connect(gain).connect(destination);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    gain.connect(analyser);
    micGainRef.current = gain;
    micAnalyserRef.current = analyser;
  };

  const toggleMicrophone = async () => {
    const enable = !micEnabledRef.current;
    micEnabledRef.current = enable;
    setMicEnabled(enable);
    const context = contextRef.current;
    const destination = destinationRef.current;
    try {
      if (enable && context && destination && !micStreamRef.current) {
        await connectMicrophone(context, destination);
      }
      micStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = enable; });
      if (context && micGainRef.current) {
        micGainRef.current.gain.setValueAtTime(enable ? 1 : 0, context.currentTime);
      }
      if (!enable) setLevels((current) => ({ ...current, mic: 0 }));
    } catch (error) {
      micEnabledRef.current = false;
      setMicEnabled(false);
      onError(errorMessage(error));
    }
  };

  const startRecording = async () => {
    if (!configured) return onConfigure();
    setCaptureState('starting');
    chunksRef.current = [];
    setElapsed(0);
    accumulatedRef.current = 0;
    try {
      const systemStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      if (!systemStream.getAudioTracks().length) throw new Error('Windows system audio was not available. Make sure audio sharing is enabled.');
      streamsRef.current = [systemStream];

      const context = new AudioContext();
      await context.resume();
      contextRef.current = context;
      const destination = context.createMediaStreamDestination();
      destinationRef.current = destination;
      const systemSource = context.createMediaStreamSource(new MediaStream(systemStream.getAudioTracks()));
      const systemGain = context.createGain();
      systemGain.gain.value = 0.88;
      systemSource.connect(systemGain).connect(destination);
      const systemAnalyser = context.createAnalyser();
      systemAnalyser.fftSize = 256;
      systemGain.connect(systemAnalyser);
      systemAnalyserRef.current = systemAnalyser;
      if (micEnabledRef.current) await connectMicrophone(context, destination);
      runMeters();

      const preferred = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(destination.stream, {
        ...(preferred ? { mimeType: preferred } : {}), audioBitsPerSecond: 32_000,
      });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onerror = () => onError('The audio recorder stopped unexpectedly.');
      recorder.onstop = async () => {
        const durationSec = Math.max(1, Math.round(accumulatedRef.current / 1000));
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        cleanCapture();
        try {
          const meeting = await window.voiceDesktop.saveAudio({
            bytes: await blob.arrayBuffer(), mimeType: blob.type || 'audio/webm', durationSec,
          });
          setCaptureState('idle');
          onSaved(meeting);
        } catch (error) {
          setCaptureState('idle');
          onError(errorMessage(error));
        }
      };
      systemStream.getVideoTracks()[0]?.addEventListener('ended', finishCapture, { once: true });
      startedAtRef.current = Date.now();
      recorder.start(1000);
      setCaptureState('recording');
      intervalRef.current = window.setInterval(() => {
        setElapsed(Math.floor((accumulatedRef.current + Date.now() - startedAtRef.current) / 1000));
      }, 500);
    } catch (error) {
      cleanCapture();
      setCaptureState('idle');
      onError(errorMessage(error));
    }
  };

  const togglePause = () => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (recorder.state === 'recording') {
      accumulatedRef.current += Date.now() - startedAtRef.current;
      recorder.pause();
      setCaptureState('paused');
      stopMeters();
    } else if (recorder.state === 'paused') {
      startedAtRef.current = Date.now();
      recorder.resume();
      setCaptureState('recording');
      runMeters();
    }
  };

  const discard = () => {
    const recorder = recorderRef.current;
    if (recorder) recorder.onstop = null;
    if (recorder?.state !== 'inactive') recorder?.stop();
    cleanCapture();
    setElapsed(0);
    setCaptureState('idle');
  };

  const importAudio = async (file: File) => {
    if (!configured) return onConfigure();
    if (file.size > 30 * 1024 * 1024) return onError('Audio is above the 30MB limit.');
    setCaptureState('saving');
    try {
      const durationSec = await probeDuration(file);
      const meeting = await window.voiceDesktop.saveAudio({
        bytes: await file.arrayBuffer(), mimeType: file.type || 'audio/mpeg', durationSec, originalName: file.name,
      });
      onSaved(meeting);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setCaptureState('idle');
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const active = ['recording', 'paused', 'starting', 'saving'].includes(captureState);
  return (
    <section className="record-page page-pad">
      <header className="page-header"><div><p className="eyebrow">NEW RECORDING</p><h1>Capture every voice.</h1><p>Record Windows audio and your microphone together—perfect for Teams, Meet, YouTube, webinars, and any app playing sound.</p></div><div className="source-strip"><SourceChip icon={<MonitorSpeaker size={17} />} label="System audio" live={captureState === 'recording'} level={levels.system} /><SourceChip icon={<Mic size={17} />} label={`Microphone ${micEnabled ? 'on' : 'off'}`} enabled={micEnabled} live={captureState === 'recording' && micEnabled} level={levels.mic} onClick={() => void toggleMicrophone()} disabled={captureState === 'starting' || captureState === 'saving'} /></div></header>

      {!configured && <div className="setup-callout"><KeyRound size={21} /><div><strong>Finish setup before your first recording</strong><span>Add a Gemini key and Drive Apps Script URL. Nothing is built into the installer.</span></div><button onClick={onConfigure}>Open settings <ChevronRight size={16} /></button></div>}

      <div className={`recorder-card ${active ? 'active' : ''}`}>
        <div className="orb-wrap"><div className="orb-ring ring-3"/><div className="orb-ring ring-2"/><div className="orb-ring ring-1"/><button className="record-orb" disabled={captureState !== 'idle'} onClick={startRecording} aria-label="Start recording">{captureState === 'starting' ? <LoaderCircle className="spin" /> : captureState === 'saving' ? <Upload className="pulse" /> : <Mic size={46} />}</button></div>
        {captureState === 'idle' || captureState === 'starting' || captureState === 'saving' ? (
          <div className="recorder-copy"><h2>{captureState === 'starting' ? 'Connecting audio…' : captureState === 'saving' ? 'Saving safely…' : 'Ready to record'}</h2><p>{captureState === 'idle' ? 'Start before your call. The meeting stays audible while the app captures it.' : 'Keep this window open for a moment.'}</p><button className="primary-button" onClick={startRecording} disabled={captureState !== 'idle'}><Radio size={19} /> Start recording</button><button className="secondary-button" disabled={captureState !== 'idle'} onClick={() => inputRef.current?.click()}><Upload size={18} /> Import audio</button><input ref={inputRef} hidden type="file" accept="audio/*,video/webm" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importAudio(file); }} /></div>
        ) : (
          <div className="capture-panel"><div className="live-pill"><span />{captureState === 'paused' ? 'PAUSED' : 'RECORDING'}</div><div className="record-time">{formatDuration(elapsed)}</div><div className="level-stack"><LevelRow icon={<MonitorSpeaker size={16}/>} label="System" value={levels.system}/><LevelRow icon={<Mic size={16}/>} label={micEnabled ? 'Microphone' : 'Mic muted'} value={levels.mic}/></div><div className="record-controls"><button onClick={discard} title="Discard"><X /></button><button className="stop" onClick={finishCapture} title="Stop"><Square fill="currentColor" /></button><button onClick={togglePause} title={captureState === 'paused' ? 'Resume' : 'Pause'}>{captureState === 'paused' ? <Play fill="currentColor"/> : <Pause fill="currentColor"/>}</button></div></div>
        )}
      </div>

      {progress && <ProcessingCard event={progress} />}
      <div className="capture-note"><ShieldCheck size={17}/><span><strong>Private by design.</strong> Audio is saved locally first, then sent directly to Gemini and your Drive. It does not pass through another server.</span></div>
    </section>
  );
}

function SourceChip({ icon, label, live, level, enabled = true, disabled, onClick }: { icon: React.ReactNode; label: string; live: boolean; level: number; enabled?: boolean; disabled?: boolean; onClick?(): void }) {
  const content = <>{icon}<span>{label}</span><i className={live ? 'live' : ''} style={{ opacity: live ? .45 + level * .55 : .28 }} /></>;
  return onClick
    ? <button type="button" className={`source-chip toggle ${enabled ? 'enabled' : 'off'}`} aria-pressed={enabled} disabled={disabled} onClick={onClick}>{content}</button>
    : <div className="source-chip">{content}</div>;
}

function LevelRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return <div className="level-row"><span>{icon}{label}</span><div><i style={{ width: `${Math.max(3, value * 100)}%` }} /></div></div>;
}

function ProcessingCard({ event }: { event: ProcessingEvent }) {
  const detail = event.model ? `${event.model} · key ${event.keyNumber} of ${event.keyCount}` : event.message;
  return <div className={`processing-card ${event.stage === 'error' ? 'failed' : ''}`}><div className="process-icon">{event.stage === 'done' ? <Check/> : event.stage === 'error' ? <CircleHelp/> : <Sparkles className="pulse"/>}</div><div><strong>{event.stage === 'done' ? 'Meeting ready' : event.stage === 'error' ? 'Processing paused' : statusLabel(event.stage as Meeting['status'])}</strong><span>{detail || 'Working in the background'}</span></div>{!['done', 'error'].includes(event.stage) && <LoaderCircle className="spin"/>}</div>;
}

function HistoryPage({ meetings, selectedId, progress, taskNoteConfigured, onSelect, onRefresh, onRetry, onError }: {
  meetings: Meeting[]; selectedId: string | null; progress: Record<string, ProcessingEvent>; taskNoteConfigured: boolean;
  onSelect(id: string | null): void; onRefresh(): Promise<Meeting[]>; onRetry(id: string): void; onError(message: string): void;
}) {
  const selected = meetings.find((meeting) => meeting.id === selectedId) || meetings[0] || null;
  useEffect(() => { if (!selectedId && meetings[0]) onSelect(meetings[0].id); }, [meetings, onSelect, selectedId]);
  return <section className="history-page"><div className="history-list"><header><div><p className="eyebrow">LIBRARY</p><h1>History</h1></div><span>{meetings.length} recordings</span></header>{meetings.length === 0 ? <div className="empty-state"><History size={32}/><strong>No recordings yet</strong><span>Your finished meetings will appear here.</span></div> : <div className="meeting-list">{meetings.map((meeting) => <MeetingRow key={meeting.id} meeting={meeting} selected={meeting.id === selected?.id} progress={progress[meeting.id]} taskNoteConfigured={taskNoteConfigured} onClick={() => onSelect(meeting.id)} />)}</div>}</div><div className="detail-pane">{selected ? <MeetingDetail meeting={selected} progress={progress[selected.id]} taskNoteConfigured={taskNoteConfigured} onRefresh={onRefresh} onRetry={() => onRetry(selected.id)} onDelete={async () => { try { await window.voiceDesktop.deleteMeeting(selected.id); onSelect(null); await onRefresh(); } catch (error) { onError(errorMessage(error)); } }} onError={onError}/> : <div className="empty-detail"><FileAudio size={36}/><span>Select a recording to read it.</span></div>}</div></section>;
}

function MeetingRow({ meeting, selected, progress, taskNoteConfigured, onClick }: { meeting: Meeting; selected: boolean; progress?: ProcessingEvent; taskNoteConfigured: boolean; onClick(): void }) {
  const preview = meeting.summary.replace(/\n/g, ' ').replace(/^(OVERVIEW|KEY POINTS)\s*/i, '').slice(0, 135) || meeting.transcript.slice(0, 135) || 'Waiting to process…';
  const taskNotePending = taskNoteConfigured && meeting.status === 'done' && !meeting.taskNoteId;
  return <button className={`meeting-row ${selected ? 'selected' : ''}`} onClick={onClick}><div className="meeting-row-top"><strong>{meeting.title}</strong><span>{formatDuration(meeting.durationSec)}</span></div><p>{preview}</p><div className="meeting-meta"><span>{formatDate(meeting.createdAt)}</span><i className={`status ${taskNotePending ? 'error' : meeting.status}`}>{progress?.message || (taskNotePending ? 'TaskNote retry' : statusLabel(meeting.status))}</i></div></button>;
}

function MeetingDetail({ meeting, progress, taskNoteConfigured, onRefresh, onRetry, onDelete, onError }: { meeting: Meeting; progress?: ProcessingEvent; taskNoteConfigured: boolean; onRefresh(): Promise<Meeting[]>; onRetry(): void; onDelete(): void; onError(message: string): void }) {
  const [tab, setTab] = useState<'summary' | 'transcript' | 'ask'>('summary');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [asking, setAsking] = useState(false);
  const busy = !['done', 'error', 'saved'].includes(meeting.status);
  const taskNotePending = taskNoteConfigured && meeting.status === 'done' && !meeting.taskNoteId;
  const doAction = async (action: () => Promise<unknown>) => { try { await action(); await onRefresh(); } catch (error) { onError(errorMessage(error)); } };
  return <article className="meeting-detail"><header><div><div className={`detail-status ${meeting.status}`}><span/>{progress?.message || statusLabel(meeting.status)}</div><h2>{meeting.title}</h2><p><Clock3 size={15}/>{formatDate(meeting.createdAt)}<span>·</span>{formatDuration(meeting.durationSec)}</p></div><div className="detail-actions"><button onClick={() => void doAction(() => window.voiceDesktop.openMeetingAudio(meeting.id))} title="Open audio"><Play size={17}/></button><button onClick={() => void doAction(() => window.voiceDesktop.exportMeeting(meeting.id))} title="Export"><Download size={17}/></button><button className="danger" onClick={onDelete} disabled={busy} title="Delete"><Trash2 size={17}/></button></div></header>{(meeting.status === 'error' || taskNotePending) && <div className="detail-error"><CircleHelp size={19}/><div><strong>{taskNotePending ? 'Not posted to TaskNote' : 'Processing stopped'}</strong><span>{meeting.lastError || 'The meeting is safe in Drive. Retry to send it to TaskNote.'}</span></div><button onClick={onRetry}><RotateCcw size={15}/> {taskNotePending ? 'Post now' : 'Try again'}</button></div>}{busy && progress && <ProcessingCard event={progress}/>}<div className="detail-links">{meeting.folderUrl && <button onClick={() => window.voiceDesktop.openUrl(meeting.folderUrl!)}><FolderOpen/>Drive folder<ExternalLink/></button>}{meeting.transcriptUrl && <button onClick={() => window.voiceDesktop.openUrl(meeting.transcriptUrl!)}><FileAudio/>Transcript file<ExternalLink/></button>}</div><div className="content-tabs"><button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>Summary</button><button className={tab === 'transcript' ? 'active' : ''} onClick={() => setTab('transcript')}>Transcript</button><button className={tab === 'ask' ? 'active' : ''} onClick={() => setTab('ask')}>Ask Gemini</button></div><div className="meeting-content">{tab === 'summary' && <TextContent value={meeting.summary} empty="The summary will appear after transcription."/>}{tab === 'transcript' && <Transcript value={meeting.transcript}/>} {tab === 'ask' && <div className="ask-panel"><div className="ask-intro"><Sparkles/><div><strong>Ask about this meeting</strong><span>Answers use only the transcript and include timestamps where possible.</span></div></div>{answer && <div className="answer">{answer}</div>}<form onSubmit={async (event) => { event.preventDefault(); if (!question.trim() || asking) return; setAsking(true); try { setAnswer(await window.voiceDesktop.askMeeting(meeting.id, question.trim())); } catch (error) { onError(errorMessage(error)); } finally { setAsking(false); } }}><input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="What decisions were made?"/><button disabled={asking || !meeting.transcript}>{asking ? <LoaderCircle className="spin"/> : <Sparkles/>}</button></form></div>}</div><details className="diagnostics"><summary>Diagnostics</summary><div><span>Status <strong>{statusLabel(meeting.status)}</strong></span><span>TaskNote <strong>{meeting.taskNoteId ? 'Posted' : taskNoteConfigured ? 'Pending' : 'Disabled'}</strong></span><span>Audio <strong>{meeting.mimeType}</strong></span>{Object.entries(meeting.timings).map(([name, ms]) => <span key={name}>{name.replace(/Ms$/, '')} <strong>{(ms / 1000).toFixed(1)}s</strong></span>)}</div>{meeting.lastError && <p>{meeting.lastError}</p>}</details></article>;
}

function TextContent({ value, empty }: { value: string; empty: string }) {
  if (!value) return <div className="content-empty">{empty}</div>;
  return <div className="prose">{value.split('\n').map((line, index) => line ? <p key={index} className={/^(OVERVIEW|KEY POINTS|DECISIONS|ACTION ITEMS)$/.test(line) ? 'section-title' : ''}>{line}</p> : <br key={index}/>)}</div>;
}

function Transcript({ value }: { value: string }) {
  if (!value) return <div className="content-empty">The transcript will appear here.</div>;
  return <div className="transcript">{value.split('\n').map((line, index) => { const match = line.match(/^\[([^\]]+)]\s*(Speaker \d+):\s*(.*)$/); return match ? <div className="transcript-line" key={index}><time>{match[1]}</time><div><strong>{match[2]}</strong><p>{match[3]}</p></div></div> : <p key={index}>{line}</p>; })}</div>;
}

function SettingsPage({ initial, onSaved, onError }: { initial: Settings; onSaved(value: Settings): void; onError(message: string): void }) {
  const [form, setForm] = useState<Settings>(() => ({ ...initial, apiKeys: initial.apiKeys.length ? initial.apiKeys.map((item) => ({ ...item })) : [{ name: 'Primary', key: '' }] }));
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<Record<string, string>>({});
  const updateKey = (index: number, field: keyof ApiKeyEntry, value: string) => setForm((current) => ({ ...current, apiKeys: current.apiKeys.map((entry, i) => i === index ? { ...entry, [field]: value } : entry) }));
  const test = async (name: string, action: () => Promise<unknown>) => { setTests((current) => ({ ...current, [name]: 'Testing…' })); try { const result = await action(); const count = typeof result === 'object' && result && 'models' in result ? (result as { models: string[] }).models.length : null; setTests((current) => ({ ...current, [name]: count == null ? 'Connected' : `Connected · ${count} Flash models` })); } catch (error) { setTests((current) => ({ ...current, [name]: `Failed · ${errorMessage(error)}` })); } };
  return <section className="settings-page page-pad"><header className="page-header"><div><p className="eyebrow">PREFERENCES</p><h1>Settings</h1><p>Connect your own services. Secrets stay encrypted on this Windows account.</p></div></header><form className="settings-form" onSubmit={async (event) => { event.preventDefault(); setSaving(true); try { const saved = await window.voiceDesktop.saveSettings(form); setForm(saved.apiKeys.length ? saved : { ...saved, apiKeys: [{ name: 'Primary', key: '' }] }); onSaved(saved); } catch (error) { onError(errorMessage(error)); } finally { setSaving(false); } }}><SettingsSection icon={<KeyRound/>} title="Gemini API keys" subtitle="Keys from separate Google Cloud projects provide independent fallback capacity."><div className="key-list">{form.apiKeys.map((entry, index) => <div className="key-row" key={index}><input className="key-name" value={entry.name} onChange={(event) => updateKey(index, 'name', event.target.value)} placeholder={`Key ${index + 1}`}/><input type="password" value={entry.key} onChange={(event) => updateKey(index, 'key', event.target.value)} placeholder="Paste API key"/><button type="button" className="test-button" disabled={!entry.key} onClick={() => void test(`key-${index}`, () => window.voiceDesktop.testApiKey(entry.key))}>Test</button><button type="button" className="icon-button" aria-label="Remove key" onClick={() => setForm((current) => ({ ...current, apiKeys: current.apiKeys.filter((_, i) => i !== index) }))}><Trash2 size={16}/></button>{tests[`key-${index}`] && <small className={tests[`key-${index}`].startsWith('Failed') ? 'failed' : ''}>{tests[`key-${index}`]}</small>}</div>)}</div><button type="button" className="add-button" onClick={() => setForm((current) => ({ ...current, apiKeys: [...current.apiKeys, { name: `Backup ${current.apiKeys.length}`, key: '' }] }))}><Plus size={16}/> Add another key</button></SettingsSection><SettingsSection icon={<Cloud/>} title="Google Drive" subtitle="The Apps Script receiver stores audio, transcript, and summary in your Drive."><Field label="Apps Script /exec URL"><div className="inline-field"><input type="url" value={form.driveUrl} onChange={(event) => setForm({ ...form, driveUrl: event.target.value })} placeholder="https://script.google.com/macros/s/…/exec"/><button type="button" className="test-button" disabled={!form.driveUrl} onClick={() => void test('drive', () => window.voiceDesktop.testDrive(form.driveUrl))}>Test</button></div>{tests.drive && <small className={tests.drive.startsWith('Failed') ? 'failed' : ''}>{tests.drive}</small>}</Field><Field label="Shared secret (optional)"><input type="password" value={form.driveSecret} onChange={(event) => setForm({ ...form, driveSecret: event.target.value })} placeholder="Only if configured in Apps Script"/></Field></SettingsSection><SettingsSection icon={<Sparkles/>} title="TaskNote" subtitle="Optionally mirror finished meetings to the web app."><Field label="TaskNote URL (optional)"><div className="inline-field"><input type="url" value={form.taskNoteUrl} onChange={(event) => setForm({ ...form, taskNoteUrl: event.target.value })} placeholder="https://your-tasknote.example"/><button type="button" className="test-button" disabled={!form.taskNoteUrl} onClick={() => void test('tasknote', () => window.voiceDesktop.testTaskNote(form.taskNoteUrl))}>Test</button></div>{tests.tasknote && <small className={tests.tasknote.startsWith('Failed') ? 'failed' : ''}>{tests.tasknote}</small>}</Field></SettingsSection><div className="save-bar"><div><ShieldCheck size={17}/><span>Saved values are protected by Windows DPAPI.</span></div><button className="primary-button compact" disabled={saving}>{saving ? <LoaderCircle className="spin"/> : <Check/>} Save settings</button></div></form></section>;
}

function SettingsSection({ icon, title, subtitle, children }: { icon: React.ReactNode; title: string; subtitle: string; children: React.ReactNode }) {
  return <section className="settings-section"><header><div className="section-icon">{icon}</div><div><h2>{title}</h2><p>{subtitle}</p></div></header><div className="section-body">{children}</div></section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function probeDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    audio.preload = 'metadata';
    const finish = (value: number) => { URL.revokeObjectURL(url); resolve(Number.isFinite(value) ? Math.round(value) : 0); };
    audio.onloadedmetadata = () => finish(audio.duration);
    audio.onerror = () => finish(0);
    audio.src = url;
  });
}
