import { useEffect, useLayoutEffect, useState } from 'react';
import {
  Alert,
  Linking,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { File } from 'expo-file-system';

import LevelMeter from '../components/LevelMeter';
import ProcessingSteps, { type Step, type StepState } from '../components/ProcessingSteps';
import { importAudioFile, pickAudioFile, probeDuration } from '../audioFile';
import {
  acquireForegroundService,
  releaseForegroundService,
} from '../foregroundService';
import { MAX_INLINE_AUDIO_BYTES } from '../config';
import { useGeminiActivity } from '../useGeminiActivity';
import CopyButton from '../components/CopyButton';
import TranscriptView from '../components/TranscriptView';
import { getMeeting, insertMeeting } from '../db';
import { persistRecording, processMeeting } from '../pipeline';
import { MEETING_RECORDING_OPTIONS, formatDuration } from '../recording';
import { useSettings } from '../SettingsContext';
import { validateSettings } from '../settings';
import { colors, radius, space, text } from '../theme';

type Stage =
  | 'idle'
  | 'recording'
  | 'paused'
  | 'transcribing'
  | 'summarizing'
  | 'uploading'
  | 'posting'
  | 'done';

const ORDER: Stage[] = ['transcribing', 'summarizing', 'uploading', 'posting'];

const STEP_LABELS: Record<string, string> = {
  transcribing: 'Transcribing audio',
  summarizing: 'Writing summary',
  uploading: 'Saving to Drive',
  posting: 'Posting to TaskNote',
};

export default function RecordScreen() {
  const navigation = useNavigation();
  const { settings } = useSettings();
  const recorder = useAudioRecorder(MEETING_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder);

  const [stage, setStage] = useState<Stage>('idle');
  const [transcript, setTranscript] = useState('');
  const [summary, setSummary] = useState('');
  const [folderUrl, setFolderUrl] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const capturing = stage === 'recording' || stage === 'paused';
  const processing = ORDER.includes(stage);
  const geminiNote = useGeminiActivity(processing);

  // Immersive only while actually capturing. Processing keeps the normal chrome
  // so the app still looks like itself, and so History stays reachable.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: !capturing,
      tabBarStyle: capturing
        ? { display: 'none' as const }
        : {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            height: 62,
            paddingBottom: 8,
            paddingTop: 8,
          },
    });
  }, [navigation, capturing]);

  useEffect(() => {
    (async () => {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        Alert.alert(
          'Microphone needed',
          'VoiceToText cannot record meetings without microphone access.'
        );
        return;
      }

      // Android 13+ needs notification permission for the foreground service's
      // ongoing notification. The service still runs without it, but the user
      // gets no visible indication that recording is live.
      if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
        ).catch(() => undefined);
      }

      // allowsBackgroundRecording binds expo-audio's microphone-type foreground
      // service. Without it Android suspends the process when the screen turns
      // off and the recording silently stops.
      await setAudioModeAsync({
        allowsRecording: true,
        allowsBackgroundRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
      });
    })();
  }, []);

  async function startRecording() {
    const problem = validateSettings(settings);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setTranscript('');
    setSummary('');
    setFolderUrl(null);
    setSavedId(null);
    await recorder.prepareToRecordAsync();
    recorder.record();
    setStage('recording');
  }

  function togglePause() {
    if (stage === 'recording') {
      recorder.pause();
      setStage('paused');
    } else {
      recorder.record();
      setStage('recording');
    }
  }

  function cancelRecording() {
    const elapsed = formatDuration(recorderState.durationMillis / 1000);
    // Pause first so the meeting is not still being captured while the user
    // reads the dialog, and so "Keep recording" can simply resume.
    const wasRecording = stage === 'recording';
    if (wasRecording) recorder.pause();
    setStage('paused');

    Alert.alert(
      'Discard this recording?',
      `${elapsed} will be deleted. This cannot be undone — it is never transcribed or saved to Drive.`,
      [
        {
          text: 'Keep recording',
          style: 'cancel',
          onPress: () => {
            if (wasRecording) {
              recorder.record();
              setStage('recording');
            }
          },
        },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: async () => {
            await recorder.stop().catch(() => undefined);
            const uri = recorder.uri;
            if (uri) {
              try {
                const file = new File(uri);
                if (file.exists) file.delete();
              } catch {
                // A stranded cache file is harmless — the OS clears it.
              }
            }
            setStage('idle');
            setError(null);
            setTranscript('');
            setSummary('');
            setFolderUrl(null);
            setSavedId(null);
          },
        },
      ]
    );
  }

  async function stopAndProcess() {
    const durationSec = Math.round(recorderState.durationMillis / 1000);
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri) {
      setStage('idle');
      setError('Recording produced no file.');
      return;
    }

    const createdAt = Date.now();
    const title = `Meeting ${new Date(createdAt).toISOString().slice(0, 16).replace('T', ' ')}`;

    // Persist audio and create the row BEFORE any network call. Everything
    // after this point is retryable; nothing after this point can lose the
    // recording.
    let meetingId: number;
    try {
      const audioPath = await persistRecording(uri, String(createdAt));
      meetingId = await insertMeeting({
        title,
        createdAt,
        durationSec,
        transcript: '',
        summary: '',
        audioUrl: null,
        transcriptUrl: null,
        folderUrl: null,
        audioPath,
        lastError: null,
        taskNoteId: null,
      });
    } catch (err) {
      setError(
        `Could not save the recording: ${err instanceof Error ? err.message : String(err)}`
      );
      setStage('idle');
      return;
    }

    await runPipeline(meetingId);
  }

  /**
   * Shared by recording and importing: once a meeting row exists, both are the
   * same job. Keeping one copy means an imported file can never quietly get
   * different handling from a recording.
   */
  async function runPipeline(meetingId: number) {
    setSavedId(meetingId);
    setError(null);

    // Hold the foreground service for the whole pipeline so an import/record
    // that is still transcribing survives the screen locking, exactly as a
    // History retry does. Acquired here while the app is foregrounded.
    await acquireForegroundService();
    try {
      const done = await processMeeting({
        meetingId,
        settings,
        onStage: (next) => setStage(next === 'done' ? 'done' : next),
      });
      setTranscript(done.transcript);
      setSummary(done.summary);
      setFolderUrl(done.folderUrl);
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      const saved = await getMeeting(meetingId).catch(() => null);
      if (saved) {
        setTranscript(saved.transcript);
        setSummary(saved.summary);
        setFolderUrl(saved.folderUrl);
      }
      setStage('done');
    } finally {
      await releaseForegroundService();
    }
  }

  /**
   * Imports an existing audio file and runs it through the same pipeline. The
   * file is copied into document storage and the row written before any network
   * call, exactly as a recording is — so an import that fails mid-transcription
   * is retryable rather than lost.
   */
  async function importFile() {
    setError(null);

    let picked;
    try {
      picked = await pickAudioFile();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!picked) return;

    // Checked before copying: an oversized file cannot be transcribed, and
    // saying so now beats writing it to storage first and failing afterwards.
    if (picked.size > MAX_INLINE_AUDIO_BYTES) {
      setError(
        `That file is ${(picked.size / 1024 / 1024).toFixed(1)}MB, above the ` +
          `${MAX_INLINE_AUDIO_BYTES / 1024 / 1024}MB limit.`
      );
      return;
    }

    setStage('transcribing');
    const createdAt = Date.now();
    const title = `Meeting ${new Date(createdAt).toISOString().slice(0, 16).replace('T', ' ')}`;

    let meetingId: number;
    try {
      // Unknown duration is survivable — it only costs timestamp rescaling —
      // so a file that will not load is still imported.
      const durationSec = await probeDuration(picked.uri);
      const audioPath = await importAudioFile(picked.uri, String(createdAt), picked.extension);
      meetingId = await insertMeeting({
        title,
        createdAt,
        durationSec,
        transcript: '',
        summary: '',
        audioUrl: null,
        transcriptUrl: null,
        folderUrl: null,
        audioPath,
        lastError: null,
        taskNoteId: null,
      });
    } catch (err) {
      setError(`Could not import the file: ${err instanceof Error ? err.message : String(err)}`);
      setStage('idle');
      return;
    }

    await runPipeline(meetingId);
  }

  async function retry() {
    if (savedId == null) return;
    setError(null);
    try {
      const done = await processMeeting({
        meetingId: savedId,
        settings,
        onStage: (next) => setStage(next === 'done' ? 'done' : next),
      });
      setTranscript(done.transcript);
      setSummary(done.summary);
      setFolderUrl(done.folderUrl);
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage('done');
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={capturing ? ['top', 'bottom'] : ['bottom']}>
      {capturing && (
        <CaptureView
          stage={stage}
          durationMillis={recorderState.durationMillis}
          metering={recorderState.metering}
          onTogglePause={togglePause}
          onStop={stopAndProcess}
          onCancel={cancelRecording}
        />
      )}

      {!capturing && (
        <ScrollView contentContainerStyle={styles.scroll}>
          {processing && (
            <View style={styles.block}>
              <Text style={text.h1}>Processing</Text>
              <Text style={styles.sub}>
                {formatDuration(recorderState.durationMillis / 1000)} recorded · keep the app open
              </Text>
              <View style={styles.gap}>
                <ProcessingSteps
                  steps={buildSteps(
                    stage,
                    error,
                    Boolean(settings.taskNoteUrl.trim()),
                    geminiNote
                  )}
                />
              </View>
            </View>
          )}

          {stage === 'idle' && (
            <View style={styles.idle}>
              <View style={styles.idleArt}>
                <Text style={styles.idleGlyph}>🎙</Text>
              </View>
              <Text style={text.h1}>Ready to record</Text>
              <Text style={styles.sub}>
                Audio is transcribed by Gemini and saved to your Drive.
              </Text>
              <Pressable
                onPress={startRecording}
                style={({ pressed }) => [styles.startBtn, pressed && styles.pressed]}
              >
                <Text style={styles.startText}>Start Recording</Text>
              </Pressable>
              <Pressable
                onPress={importFile}
                style={({ pressed }) => [styles.importBtn, pressed && styles.pressed]}
              >
                <Text style={styles.importText}>Import audio file</Text>
              </Pressable>
            </View>
          )}

          {error && (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
              {savedId != null && (
                <>
                  <Text style={styles.errorNote}>
                    Your recording is saved on this device. Nothing was lost — retry
                    when you're ready, or from the History tab later.
                  </Text>
                  <Pressable
                    onPress={retry}
                    style={({ pressed }) => [styles.retryBtn, pressed && styles.pressed]}
                  >
                    <Text style={styles.retryText}>Try now</Text>
                  </Pressable>
                </>
              )}
            </View>
          )}

          {stage === 'done' && (
            <View style={styles.block}>
              <View style={styles.doneHead}>
                <Text style={text.h1}>{error ? 'Saved' : 'Done'}</Text>
                <Pressable
                  onPress={startRecording}
                  style={({ pressed }) => [styles.newBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.newBtnText}>New recording</Text>
                </Pressable>
              </View>

              {folderUrl && (
                <Pressable onPress={() => Linking.openURL(folderUrl)}>
                  <Text style={styles.link}>Open folder in Drive ↗</Text>
                </Pressable>
              )}

              {summary ? (
                <View style={styles.card}>
                  <View style={styles.cardHead}>
                    <Text style={styles.cardTitle}>Summary</Text>
                    <CopyButton value={summary} />
                  </View>
                  <Text style={text.body} selectable>
                    {summary}
                  </Text>
                </View>
              ) : null}

              {transcript ? (
                <View style={styles.card}>
                  <View style={styles.cardHead}>
                    <Text style={styles.cardTitle}>Transcript</Text>
                    <CopyButton value={transcript} />
                  </View>
                  <TranscriptView transcript={transcript} />
                </View>
              ) : null}
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function CaptureView(props: {
  stage: Stage;
  durationMillis: number;
  metering?: number;
  onTogglePause: () => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  const paused = props.stage === 'paused';
  return (
    <View style={styles.capture}>
      <View style={styles.captureTop}>
        <View style={[styles.pill, paused ? styles.pillPaused : styles.pillLive]}>
          <View style={[styles.dot, paused && styles.dotPaused]} />
          <Text style={styles.pillText}>{paused ? 'Paused' : 'Recording'}</Text>
        </View>
      </View>

      <View style={styles.captureMid}>
        <Text style={styles.bigTimer}>{formatDuration(props.durationMillis / 1000)}</Text>
        <LevelMeter metering={props.metering} active={!paused} />
      </View>

      <View style={styles.captureControls}>
        <Pressable
          onPress={props.onCancel}
          style={({ pressed }) => [styles.circleBtn, pressed && styles.pressed]}
        >
          <Text style={styles.cancelGlyph}>✕</Text>
        </Pressable>
        <Pressable
          onPress={props.onStop}
          style={({ pressed }) => [styles.stopBtn, pressed && styles.pressed]}
        >
          <View style={styles.stopSquare} />
        </Pressable>
        <Pressable
          onPress={props.onTogglePause}
          style={({ pressed }) => [styles.circleBtn, pressed && styles.pressed]}
        >
          <Text style={styles.circleGlyph}>{paused ? '▶' : '❚❚'}</Text>
        </Pressable>
      </View>

      <View style={styles.captureLabels}>
        <Text style={[styles.controlLabel, styles.sideLabel]}>Discard</Text>
        <Text style={[styles.controlLabel, styles.centreLabel]}>Stop</Text>
        <Text style={[styles.controlLabel, styles.sideLabel]}>
          {paused ? 'Resume' : 'Pause'}
        </Text>
      </View>

      <Text style={styles.captureHint}>
        {paused ? 'Resume when the meeting continues' : 'Stop to transcribe and save'}
      </Text>
    </View>
  );
}

/** The TaskNote step only appears when a TaskNote URL is configured. */
function buildSteps(
  stage: Stage,
  error: string | null,
  withTaskNote: boolean,
  note: string | null
): Step[] {
  const stages = withTaskNote ? ORDER : ORDER.filter((s) => s !== 'posting');
  const current = stages.indexOf(stage);
  return stages.map((key, index) => {
    let state: StepState = 'pending';
    if (current > index) state = 'done';
    else if (current === index) state = error ? 'failed' : 'active';
    // Only the Gemini stages have a model to report; Drive and TaskNote do not.
    const showNote = state === 'active' && (key === 'transcribing' || key === 'summarizing');
    return {
      key,
      label: STEP_LABELS[key],
      state,
      note: showNote ? note ?? undefined : undefined,
    };
  });
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { padding: space.xl, paddingBottom: space.xxl },
  block: { gap: space.md },
  gap: { marginTop: space.sm },
  sub: { ...text.meta, marginTop: -space.xs },

  idle: { alignItems: 'center', paddingTop: 56, gap: space.md },
  idleArt: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  idleGlyph: { fontSize: 42 },
  startBtn: {
    marginTop: space.xl,
    backgroundColor: colors.accent,
    borderRadius: radius.pill,
    paddingVertical: 17,
    paddingHorizontal: 44,
  },
  startText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  // Secondary to recording, which is what the screen is for.
  importBtn: {
    marginTop: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 13,
    paddingHorizontal: 28,
  },
  importText: { color: colors.textFaint, fontSize: 14, fontWeight: '600' },

  capture: { flex: 1, justifyContent: 'space-between', paddingVertical: space.xxl },
  captureTop: { alignItems: 'center', paddingTop: space.lg },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  pillLive: { backgroundColor: colors.dangerSoft },
  pillPaused: { backgroundColor: colors.surfaceAlt },
  pillText: { color: colors.text, fontSize: 13, fontWeight: '700', letterSpacing: 0.4 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.danger },
  dotPaused: { backgroundColor: colors.textDim },
  captureMid: { alignItems: 'center', gap: space.xl },
  bigTimer: {
    color: colors.text,
    fontSize: 68,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
  },
  captureControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xxl,
  },
  circleBtn: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleGlyph: { color: colors.text, fontSize: 18, fontWeight: '700' },
  cancelGlyph: { color: colors.textDim, fontSize: 20, fontWeight: '700' },
  captureLabels: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.xxl,
    marginTop: space.sm,
  },
  // Widths mirror the buttons above (60 / 84 / 60) so each label sits under its
  // own control rather than drifting out of alignment.
  controlLabel: {
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '600',
    color: colors.textFaint,
  },
  sideLabel: { width: 60 },
  centreLabel: { width: 84 },
  stopBtn: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopSquare: { width: 28, height: 28, borderRadius: 6, backgroundColor: '#fff' },
  captureHint: { ...text.meta, textAlign: 'center' },

  doneHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  newBtn: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  newBtnText: { color: colors.link, fontSize: 13, fontWeight: '700' },
  link: { color: colors.link, fontSize: 14, fontWeight: '600' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.sm,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  cardTitle: { ...text.h2 },
  errorCard: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: space.lg,
    marginTop: space.lg,
  },
  errorText: { color: '#ffb4ac', fontSize: 14, lineHeight: 20 },
  errorNote: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: space.md },
  retryBtn: {
    marginTop: space.lg,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  retryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.65 },
});
