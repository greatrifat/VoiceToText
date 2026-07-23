import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { File } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { mimeForPath } from '../audioFile';
import { updateSummary, type Meeting } from '../db';
import { askAboutTranscript, summarizeTranscript } from '../gemini';
import CopyButton from '../components/CopyButton';
import TranscriptView from '../components/TranscriptView';
import { canRetry, needsRetry, type PipelineStage } from '../pipeline';
import { useGeminiActivity } from '../useGeminiActivity';
import { formatDuration } from '../recording';
import { useProcessing } from '../ProcessingContext';
import { useSettings } from '../SettingsContext';
import { apiKeyValues } from '../settings';
import { colors, radius, space, text } from '../theme';

type Tab = 'summary' | 'transcript' | 'ask';

type Exchange = { question: string; answer: string };

const STAGE_LABELS: Record<PipelineStage, string> = {
  transcribing: 'Transcribing…',
  summarizing: 'Writing summary…',
  uploading: 'Saving to Drive…',
  posting: 'Posting to TaskNote…',
  done: 'Done',
};

const TABS: { key: Tab; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'ask', label: 'Ask' },
];

/** Mirror of the pipeline's `Timings`; read-only here, so kept local. */
type AttemptLogRow = { model: string; key: number; outcome: string; ms: number };
type Timings = {
  durationSec?: number;
  audioBytes?: number;
  base64Ms?: number;
  transcribeMs?: number;
  transcribeModel?: string | null;
  transcribeAttempts?: number;
  transcribeLog?: AttemptLogRow[];
  summaryMs?: number;
  summaryModel?: string | null;
  summaryLog?: AttemptLogRow[];
  uploadMs?: number;
  postMs?: number;
};

const secs = (ms?: number) => (ms == null ? null : `${(ms / 1000).toFixed(1)}s`);
const mb = (bytes?: number) => (bytes == null ? null : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Shortens the model id so a walk log line fits: gemini-3-flash-preview -> 3-flash-preview. */
const shortModel = (m: string) => m.replace(/^gemini-/, '');

/**
 * Where the processing time went, per meeting. Shown because a sideloaded release
 * build has no console to read — this is the only place the numbers surface. Each
 * slow stage expands into the model-walk log, so a stage that took minutes shows
 * exactly which attempts stalled and for how long. A meeting recorded before
 * timing existed simply renders nothing.
 */
function Diagnostics({ raw }: { raw: string | null }) {
  if (!raw) return null;
  let t: Timings;
  try {
    t = JSON.parse(raw) as Timings;
  } catch {
    return null;
  }

  const total =
    (t.base64Ms ?? 0) + (t.transcribeMs ?? 0) + (t.summaryMs ?? 0) + (t.uploadMs ?? 0);

  const audio =
    [t.durationSec ? formatDuration(t.durationSec) : null, mb(t.audioBytes)]
      .filter(Boolean)
      .join(' · ') || null;

  const stage = (label: string, ms?: number, model?: string | null, log?: AttemptLogRow[]) =>
    ms == null ? null : (
      <View key={label}>
        <View style={styles.diagRow}>
          <Text style={styles.diagLabel}>{label}</Text>
          <Text style={styles.diagValue}>
            {secs(ms)}
            {model ? `  ${shortModel(model)}` : ''}
          </Text>
        </View>
        {/* Expand the walk only when there was more than one attempt — a clean
            single-attempt stage needs no breakdown. */}
        {log && log.length > 1 &&
          log.map((r, i) => (
            <View key={i} style={styles.diagAttempt}>
              <Text style={styles.diagAttemptText}>
                {shortModel(r.model)} · key {r.key} · {r.outcome}
              </Text>
              <Text style={styles.diagAttemptText}>{secs(r.ms)}</Text>
            </View>
          ))}
      </View>
    );

  return (
    <View style={styles.diag}>
      <Text style={styles.diagHead}>Diagnostics</Text>
      {audio && (
        <View style={styles.diagRow}>
          <Text style={styles.diagLabel}>Audio</Text>
          <Text style={styles.diagValue}>{audio}</Text>
        </View>
      )}
      {stage('Encode', t.base64Ms)}
      {stage('Transcribe', t.transcribeMs, t.transcribeModel, t.transcribeLog)}
      {stage('Summary', t.summaryMs, t.summaryModel, t.summaryLog)}
      {stage('Upload', t.uploadMs)}
      {total > 0 && (
        <View style={[styles.diagRow, styles.diagTotal]}>
          <Text style={styles.diagLabel}>Total</Text>
          <Text style={styles.diagValue}>{secs(total)}</Text>
        </View>
      )}
    </View>
  );
}

export default function MeetingDetail(props: {
  meeting: Meeting;
  onClose: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const { meeting } = props;
  const { settings } = useSettings();
  const processing = useProcessing();

  const [tab, setTab] = useState<Tab>('summary');
  const [summary, setSummary] = useState(meeting.summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [thread, setThread] = useState<Exchange[]>([]);

  // The retry now runs in the ProcessingProvider, so it keeps going after this
  // modal is closed to browse another recording. Its live stage is read back
  // from there rather than held locally.
  const procStage = processing.stages[meeting.id];
  const retrying = procStage !== undefined;
  const retryLabel =
    procStage === undefined || procStage === 'starting'
      ? null
      : procStage === 'queued'
        ? 'Queued…'
        : STAGE_LABELS[procStage];

  // Which model is answering, so a long run is visibly working rather than just
  // spinning — during a background retry or an in-place summary/ask.
  const geminiNote = useGeminiActivity(busy || retrying);

  // A background retry updates the row in the database; when it finishes,
  // `version` ticks and the History list re-reads and hands us the fresh
  // meeting, so mirror its summary into local state for the Summary tab.
  useEffect(() => {
    setSummary(meeting.summary);
  }, [meeting.summary]);

  useEffect(() => {
    props.onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [processing.version]);

  function runRetry() {
    setError(null);
    processing.start(meeting.id);
  }

  // The recording lives in one of two places: still on the device if the Drive
  // upload has not happened, otherwise only on Drive (the local copy is deleted
  // once Drive holds it). The local file goes through the OS share sheet so it
  // can be saved anywhere; the Drive copy just opens its link to download there.
  const localAudio = meeting.audioPath;
  const canDownloadAudio = Boolean(localAudio || meeting.audioUrl);

  async function downloadAudio() {
    setError(null);
    try {
      if (localAudio && new File(localAudio).exists) {
        if (!(await Sharing.isAvailableAsync())) {
          throw new Error('Sharing is not available on this device.');
        }
        await Sharing.shareAsync(localAudio, {
          mimeType: mimeForPath(localAudio),
          dialogTitle: 'Save or share recording',
        });
      } else if (meeting.audioUrl) {
        await Linking.openURL(meeting.audioUrl);
      } else {
        throw new Error('The audio is no longer on this device or in Drive.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function generateSummary() {
    setBusy(true);
    setError(null);
    try {
      const result = await summarizeTranscript({
        apiKeys: apiKeyValues(settings),
        transcript: meeting.transcript,
      });
      setSummary(result.summary);
      await updateSummary(meeting.id, result.summary);
      props.onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function ask() {
    const q = question.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setQuestion('');
    try {
      const answer = await askAboutTranscript({
        apiKeys: apiKeyValues(settings),
        transcript: meeting.transcript,
        question: q,
      });
      setThread((prev) => [...prev, { question: q, answer }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setQuestion(q);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              {meeting.title.replace(/^Meeting\s+/, '')}
            </Text>
            <Text style={text.meta}>
              {formatDuration(meeting.durationSec)} ·{' '}
              {new Date(meeting.createdAt).toLocaleDateString()}
            </Text>
          </View>
          <Pressable onPress={props.onClose} hitSlop={14} style={styles.closeBtn}>
            <Text style={styles.close}>✕</Text>
          </Pressable>
        </View>

        <View style={styles.links}>
          {meeting.folderUrl && (
            <Pressable onPress={() => Linking.openURL(meeting.folderUrl!)}>
              <Text style={styles.link}>Open folder in Drive ↗</Text>
            </Pressable>
          )}
          {canDownloadAudio && (
            <Pressable onPress={downloadAudio}>
              <Text style={styles.link}>
                {localAudio ? 'Download audio' : 'Download audio ↗'}
              </Text>
            </Pressable>
          )}
        </View>

        <View style={styles.tabs}>
          {TABS.map(({ key, label }) => (
            <Pressable
              key={key}
              onPress={() => setTab(key)}
              style={[styles.tab, tab === key && styles.tabActive]}
            >
              <Text style={[styles.tabText, tab === key && styles.tabTextActive]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </View>

        {error && (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        {needsRetry(meeting, settings) && (
          <View style={styles.retryCard}>
            <Text style={styles.retryTitle}>
              {!meeting.transcript
                ? 'Not transcribed yet'
                : !meeting.folderUrl
                  ? 'Not saved to Drive yet'
                  : 'Not posted to TaskNote yet'}
            </Text>
            <Text style={styles.retryBody}>
              {canRetry(meeting)
                ? meeting.lastError
                  ? `Last attempt failed: ${meeting.lastError}`
                  : meeting.folderUrl
                    ? 'Everything needed is already saved on this device.'
                    : 'The audio is still on this device.'
                : 'The audio is no longer on this device, so this cannot be retried.'}
            </Text>
            {canRetry(meeting) && (
              <Pressable
                onPress={runRetry}
                disabled={retrying}
                style={({ pressed }) => [styles.retryBtn, (retrying || pressed) && styles.dim]}
              >
                {retrying ? (
                  <View style={styles.retryBusy}>
                    <ActivityIndicator color="#fff" />
                    <Text style={styles.actionText}>{retryLabel ?? 'Starting…'}</Text>
                  </View>
                ) : (
                  <Text style={styles.actionText}>Try now</Text>
                )}
              </Pressable>
            )}
            {retrying && (
              <Text style={styles.retryHint}>
                You can close this and browse other recordings — it keeps processing.
              </Text>
            )}
            {retrying && geminiNote && <Text style={styles.geminiNote}>{geminiNote}</Text>}
          </View>
        )}

        {tab === 'summary' && (
          <ScrollView style={styles.pane} contentContainerStyle={styles.paneInner}>
            {summary ? (
              <>
                <CopyButton value={summary} label="Copy summary" />
                <Text style={[text.body, styles.afterCopy]} selectable>
                  {summary}
                </Text>
              </>
            ) : (
              <View style={styles.emptyBox}>
                <Text style={text.meta}>No summary was generated for this meeting.</Text>
                <Pressable
                  onPress={generateSummary}
                  disabled={busy}
                  style={({ pressed }) => [styles.action, (busy || pressed) && styles.dim]}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.actionText}>Generate summary</Text>
                  )}
                </Pressable>
              </View>
            )}
            <Diagnostics raw={meeting.timings} />
          </ScrollView>
        )}

        {tab === 'transcript' && (
          <ScrollView style={styles.pane} contentContainerStyle={styles.paneInner}>
            <CopyButton value={meeting.transcript} label="Copy transcript" />
            <View style={styles.afterCopy}>
              <TranscriptView transcript={meeting.transcript} />
            </View>
          </ScrollView>
        )}

        {tab === 'ask' && (
          <View style={styles.flex}>
            <ScrollView style={styles.pane} contentContainerStyle={styles.paneInner}>
              {thread.length === 0 && !busy && (
                <View style={styles.suggestions}>
                  <Text style={text.meta}>Ask anything about this meeting.</Text>
                  {[
                    'What did we decide?',
                    'What are my action items?',
                    'Was a deadline mentioned?',
                  ].map((s) => (
                    <Pressable key={s} onPress={() => setQuestion(s)} style={styles.chip}>
                      <Text style={styles.chipText}>{s}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
              {thread.map((item, index) => (
                <View key={index} style={styles.exchange}>
                  <View style={styles.bubble}>
                    <Text style={styles.question}>{item.question}</Text>
                  </View>
                  <Text style={text.body} selectable>
                    {item.answer}
                  </Text>
                </View>
              ))}
              {busy && <ActivityIndicator color={colors.accent} style={styles.thinking} />}
            </ScrollView>

            <View style={styles.askRow}>
              <TextInput
                style={styles.askInput}
                value={question}
                onChangeText={setQuestion}
                placeholder="Ask about this meeting…"
                placeholderTextColor={colors.textFaint}
                multiline
              />
              <Pressable
                onPress={ask}
                disabled={busy || !question.trim()}
                style={({ pressed }) => [
                  styles.send,
                  (busy || !question.trim() || pressed) && styles.dim,
                ]}
              >
                <Text style={styles.sendText}>↑</Text>
              </Pressable>
            </View>
          </View>
        )}

        <Pressable onPress={props.onDelete} style={styles.deleteRow}>
          <Text style={styles.deleteText}>Delete from history</Text>
        </Pressable>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  diag: {
    marginTop: space.xl,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    gap: 2,
  },
  diagHead: {
    ...text.label,
    marginBottom: space.xs,
    color: colors.textDim,
  },
  diagRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  diagLabel: { fontSize: 12, color: colors.textDim },
  diagValue: {
    fontSize: 12,
    color: colors.text,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
    flexShrink: 1,
    marginLeft: space.md,
  },
  diagTotal: {
    marginTop: space.xs,
    paddingTop: space.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  // Indented walk-log lines under a slow stage: model · key · outcome … seconds.
  diagAttempt: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingLeft: space.md,
    paddingVertical: 1,
  },
  diagAttemptText: {
    fontSize: 11,
    color: colors.textFaint,
    fontVariant: ['tabular-nums'],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    gap: space.md,
  },
  headerText: { flex: 1, gap: 2 },
  title: { ...text.h1 },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  close: { color: colors.textDim, fontSize: 16 },
  links: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xl,
    paddingHorizontal: space.xl,
    marginTop: space.md,
  },
  link: {
    color: colors.link,
    fontSize: 14,
    fontWeight: '600',
  },
  tabs: {
    flexDirection: 'row',
    gap: space.sm,
    paddingHorizontal: space.xl,
    marginTop: space.lg,
  },
  tab: {
    paddingVertical: 9,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  tabActive: { backgroundColor: colors.accent },
  tabText: { fontSize: 14, fontWeight: '600', color: colors.textDim },
  tabTextActive: { color: '#fff' },
  errorCard: {
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    padding: space.md,
    marginHorizontal: space.xl,
    marginTop: space.md,
  },
  errorText: { color: '#ffb4ac', fontSize: 13, lineHeight: 19 },
  retryCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.lg,
    marginHorizontal: space.xl,
    marginTop: space.md,
    gap: space.sm,
  },
  afterCopy: { marginTop: space.md },
  retryTitle: { ...text.label, fontSize: 14 },
  retryBody: { ...text.tiny, lineHeight: 18 },
  retryBtn: {
    marginTop: space.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  retryBusy: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  retryHint: { ...text.tiny, marginTop: space.sm, textAlign: 'center', opacity: 0.7 },
  geminiNote: { ...text.tiny, marginTop: space.sm, textAlign: 'center' },
  pane: {
    flex: 1,
    marginHorizontal: space.xl,
    marginTop: space.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
  },
  paneInner: { padding: space.lg },
  emptyBox: { gap: space.lg },
  action: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: 'center',
  },
  actionText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  dim: { opacity: 0.55 },
  suggestions: { gap: space.sm },
  chip: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 7,
  },
  chipText: { color: colors.link, fontSize: 13, fontWeight: '600' },
  exchange: { marginBottom: space.xl, gap: space.md },
  bubble: {
    alignSelf: 'flex-start',
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  question: { color: colors.link, fontSize: 14, fontWeight: '600' },
  thinking: { marginTop: space.sm },
  askRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.md,
    paddingHorizontal: space.xl,
    marginTop: space.md,
  },
  askInput: {
    flex: 1,
    maxHeight: 110,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    fontSize: 15,
  },
  send: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendText: { color: '#fff', fontSize: 20, fontWeight: '700' },
  deleteRow: { alignItems: 'center', paddingVertical: space.lg },
  deleteText: { color: colors.danger, fontSize: 14, fontWeight: '600' },
});
