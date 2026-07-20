import { useEffect, useLayoutEffect, useState } from 'react';
import {
  Alert,
  Linking,
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
import { MAX_INLINE_AUDIO_BYTES } from '../config';
import { insertMeeting } from '../db';
import { uploadToDrive, type DriveUploadResult } from '../drive';
import { summarizeTranscript, transcribeAudio } from '../gemini';
import { MEETING_RECORDING_OPTIONS, RECORDING_MIME_TYPE, formatDuration } from '../recording';
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
  | 'done';

const ORDER: Stage[] = ['transcribing', 'summarizing', 'uploading'];

export default function RecordScreen() {
  const navigation = useNavigation();
  const { settings } = useSettings();
  const recorder = useAudioRecorder(MEETING_RECORDING_OPTIONS);
  const recorderState = useAudioRecorderState(recorder);

  const [stage, setStage] = useState<Stage>('idle');
  const [transcript, setTranscript] = useState('');
  const [summary, setSummary] = useState('');
  const [drive, setDrive] = useState<DriveUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const capturing = stage === 'recording' || stage === 'paused';
  const processing = ORDER.includes(stage);

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
      await setAudioModeAsync({
        allowsRecording: true,
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
    setDrive(null);
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

  async function stopAndProcess() {
    const durationSec = Math.round(recorderState.durationMillis / 1000);
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri) {
      setStage('idle');
      setError('Recording produced no file.');
      return;
    }

    const title = `Meeting ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    let body = '';
    let digest = '';
    let result: DriveUploadResult | null = null;

    try {
      const file = new File(uri);
      if (file.size && file.size > MAX_INLINE_AUDIO_BYTES) {
        throw new Error(
          `Recording is ${(file.size / 1024 / 1024).toFixed(1)}MB, above the ` +
            `${MAX_INLINE_AUDIO_BYTES / 1024 / 1024}MB limit. Record a shorter session for now.`
        );
      }
      const base64Audio = await file.base64();

      setStage('transcribing');
      body = await transcribeAudio({
        apiKeys: settings.apiKeys,
        base64Audio,
        mimeType: RECORDING_MIME_TYPE,
      });
      setTranscript(body);

      setStage('summarizing');
      try {
        digest = await summarizeTranscript({ apiKeys: settings.apiKeys, transcript: body });
        setSummary(digest);
      } catch {
        // Recoverable from History; never worth failing the whole run over.
        digest = '';
      }

      setStage('uploading');
      result = await uploadToDrive({
        driveUrl: settings.driveUrl,
        driveSecret: settings.driveSecret,
        base64Audio,
        mimeType: RECORDING_MIME_TYPE,
        fileName: title,
        transcript: body,
        summary: digest,
      });
      setDrive(result);
      setStage('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStage(body ? 'done' : 'idle');
    } finally {
      if (body) {
        await insertMeeting({
          title,
          createdAt: Date.now(),
          durationSec,
          transcript: body,
          summary: digest,
          audioUrl: result?.audioUrl ?? null,
          transcriptUrl: result?.transcriptUrl ?? null,
          folderUrl: result?.folderUrl ?? null,
        }).catch(() => undefined);
      }
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
                <ProcessingSteps steps={buildSteps(stage, error)} />
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
            </View>
          )}

          {error && (
            <View style={styles.errorCard}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {stage === 'done' && (
            <View style={styles.block}>
              <View style={styles.doneHead}>
                <Text style={text.h1}>Done</Text>
                <Pressable
                  onPress={startRecording}
                  style={({ pressed }) => [styles.newBtn, pressed && styles.pressed]}
                >
                  <Text style={styles.newBtnText}>New recording</Text>
                </Pressable>
              </View>

              {drive && (
                <Pressable onPress={() => Linking.openURL(drive.folderUrl)}>
                  <Text style={styles.link}>Open folder in Drive ↗</Text>
                </Pressable>
              )}

              {summary ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Summary</Text>
                  <Text style={text.body}>{summary}</Text>
                </View>
              ) : null}

              {transcript ? (
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Transcript</Text>
                  <Text style={text.body}>{transcript}</Text>
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
          onPress={props.onTogglePause}
          style={({ pressed }) => [styles.circleBtn, pressed && styles.pressed]}
        >
          <Text style={styles.circleGlyph}>{paused ? '▶' : '❚❚'}</Text>
        </Pressable>
        <Pressable
          onPress={props.onStop}
          style={({ pressed }) => [styles.stopBtn, pressed && styles.pressed]}
        >
          <View style={styles.stopSquare} />
        </Pressable>
        <View style={styles.circleSpacer} />
      </View>

      <Text style={styles.captureHint}>
        {paused ? 'Resume when the meeting continues' : 'Stop to transcribe and save'}
      </Text>
    </View>
  );
}

function buildSteps(stage: Stage, error: string | null): Step[] {
  const labels = ['Transcribing audio', 'Writing summary', 'Saving to Drive'];
  const current = ORDER.indexOf(stage);
  return labels.map((label, index) => {
    let state: StepState = 'pending';
    if (current > index) state = 'done';
    else if (current === index) state = error ? 'failed' : 'active';
    return { key: label, label, state };
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
  circleSpacer: { width: 60 },
  circleGlyph: { color: colors.text, fontSize: 18, fontWeight: '700' },
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
  cardTitle: { ...text.h2, marginBottom: space.xs },
  errorCard: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: space.lg,
    marginTop: space.lg,
  },
  errorText: { color: '#ffb4ac', fontSize: 14, lineHeight: 20 },
  pressed: { opacity: 0.65 },
});
