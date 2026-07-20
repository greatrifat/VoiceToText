import { useState } from 'react';
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

import { updateSummary, type Meeting } from '../db';
import { askAboutTranscript, summarizeTranscript } from '../gemini';
import { formatDuration } from '../recording';
import { useSettings } from '../SettingsContext';
import { colors, radius, space, text } from '../theme';

type Tab = 'summary' | 'transcript' | 'ask';

type Exchange = { question: string; answer: string };

const TABS: { key: Tab; label: string }[] = [
  { key: 'summary', label: 'Summary' },
  { key: 'transcript', label: 'Transcript' },
  { key: 'ask', label: 'Ask' },
];

export default function MeetingDetail(props: {
  meeting: Meeting;
  onClose: () => void;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const { meeting } = props;
  const { settings } = useSettings();

  const [tab, setTab] = useState<Tab>('summary');
  const [summary, setSummary] = useState(meeting.summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [question, setQuestion] = useState('');
  const [thread, setThread] = useState<Exchange[]>([]);

  async function generateSummary() {
    setBusy(true);
    setError(null);
    try {
      const result = await summarizeTranscript({
        apiKeys: settings.apiKeys,
        transcript: meeting.transcript,
      });
      setSummary(result);
      await updateSummary(meeting.id, result);
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
        apiKeys: settings.apiKeys,
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

        {meeting.folderUrl && (
          <Pressable onPress={() => Linking.openURL(meeting.folderUrl!)}>
            <Text style={styles.link}>Open folder in Drive ↗</Text>
          </Pressable>
        )}

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

        {tab === 'summary' && (
          <ScrollView style={styles.pane} contentContainerStyle={styles.paneInner}>
            {summary ? (
              <Text style={text.body}>{summary}</Text>
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
          </ScrollView>
        )}

        {tab === 'transcript' && (
          <ScrollView style={styles.pane} contentContainerStyle={styles.paneInner}>
            <Text style={text.body}>{meeting.transcript}</Text>
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
                  <Text style={text.body}>{item.answer}</Text>
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
  link: {
    color: colors.link,
    fontSize: 14,
    fontWeight: '600',
    paddingHorizontal: space.xl,
    marginTop: space.md,
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
