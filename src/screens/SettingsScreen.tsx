import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';

import { getTodayUsage, type DailyUsage } from '../db';
import { verifyDriveUrl } from '../drive';
import { verifyApiKey } from '../gemini';
import { verifyTaskNoteUrl } from '../tasknote';
import { useSettings } from '../SettingsContext';
import { defaultName, type Settings } from '../settings';
import { colors, radius, space, text } from '../theme';
import { VERSION_LABEL } from '../version';

type CheckState = { status: 'idle' | 'busy' | 'ok' | 'fail'; message?: string };

export default function SettingsScreen() {
  const { settings, ready, update } = useSettings();
  const [draft, setDraft] = useState<Settings>(settings);
  const [saved, setSaved] = useState(false);
  const [keyChecks, setKeyChecks] = useState<Record<number, CheckState>>({});
  const [urlCheck, setUrlCheck] = useState<CheckState>({ status: 'idle' });
  const [taskNoteCheck, setTaskNoteCheck] = useState<CheckState>({ status: 'idle' });
  const [usage, setUsage] = useState<DailyUsage | null>(null);

  useEffect(() => {
    if (ready) {
      // Always render at least one field so the screen is never blank.
      setDraft({
        ...settings,
        apiKeys: settings.apiKeys.length ? settings.apiKeys : [{ name: '', key: '' }],
      });
    }
  }, [ready, settings]);

  useFocusEffect(
    useCallback(() => {
      getTodayUsage().then(setUsage);
    }, [])
  );

  async function onSave() {
    await update({
      apiKeys: draft.apiKeys
        .map((k) => ({ name: k.name.trim(), key: k.key.trim() }))
        .filter((k) => k.key),
      driveUrl: draft.driveUrl.trim(),
      driveSecret: draft.driveSecret.trim(),
      taskNoteUrl: draft.taskNoteUrl.trim(),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function setKey(index: number, value: string) {
    const apiKeys = [...draft.apiKeys];
    apiKeys[index] = { ...apiKeys[index], key: value };
    setDraft({ ...draft, apiKeys });
    setKeyChecks((prev) => ({ ...prev, [index]: { status: 'idle' } }));
  }

  function setKeyName(index: number, value: string) {
    const apiKeys = [...draft.apiKeys];
    apiKeys[index] = { ...apiKeys[index], name: value };
    setDraft({ ...draft, apiKeys });
  }

  function addKey() {
    setDraft({ ...draft, apiKeys: [...draft.apiKeys, { name: '', key: '' }] });
  }

  function removeKey(index: number) {
    const apiKeys = draft.apiKeys.filter((_, i) => i !== index);
    setDraft({ ...draft, apiKeys: apiKeys.length ? apiKeys : [{ name: '', key: '' }] });
    setKeyChecks({});
  }

  async function testKey(index: number) {
    setKeyChecks((prev) => ({ ...prev, [index]: { status: 'busy' } }));
    try {
      await verifyApiKey(draft.apiKeys[index].key.trim());
      setKeyChecks((prev) => ({ ...prev, [index]: { status: 'ok', message: 'Key works.' } }));
    } catch (err) {
      setKeyChecks((prev) => ({
        ...prev,
        [index]: { status: 'fail', message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  async function testUrl() {
    setUrlCheck({ status: 'busy' });
    try {
      await verifyDriveUrl(draft.driveUrl.trim());
      setUrlCheck({ status: 'ok', message: 'Script is live.' });
    } catch (err) {
      setUrlCheck({ status: 'fail', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function testTaskNote() {
    setTaskNoteCheck({ status: 'busy' });
    try {
      await verifyTaskNoteUrl(draft.taskNoteUrl.trim());
      setTaskNoteCheck({ status: 'ok', message: 'TaskNote is reachable.' });
    } catch (err) {
      setTaskNoteCheck({
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <Section title="Gemini API keys">
            <Text style={styles.sectionHint}>
              Tried in the order below — the number on the left is the position
              processing reports as "key 2 of 4". Name them however you like; the
              name is only for you. If the first runs out of quota the next is used
              automatically — but only keys from <Text style={styles.em}>different Google
              accounts</Text> have separate quota. Several keys from one account share a
              single limit.
            </Text>

            {draft.apiKeys.map((entry, index) => (
              <View key={index} style={styles.keyBlock}>
                <View style={styles.keyHead}>
                  <Text style={styles.keyIndex}>{index + 1}</Text>
                  {draft.apiKeys.length > 1 && (
                    <Pressable onPress={() => removeKey(index)} hitSlop={10}>
                      <Text style={styles.remove}>Remove</Text>
                    </Pressable>
                  )}
                </View>
                <TextInput
                  style={styles.input}
                  value={entry.name}
                  onChangeText={(value) => setKeyName(index, value)}
                  placeholder={`Name — e.g. work account (${defaultName(index)})`}
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={40}
                />
                <TextInput
                  // Shown in the clear: this screen is behind the device lock,
                  // and a masked key cannot be checked against the one in the
                  // console, which is the only way to tell four of them apart.
                  style={[styles.input, styles.keyInput]}
                  value={entry.key}
                  onChangeText={(value) => setKey(index, value)}
                  placeholder="AIza…"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  multiline
                />
                <TestRow
                  label="Test"
                  state={keyChecks[index] ?? { status: 'idle' }}
                  onPress={() => testKey(index)}
                  disabled={!entry.key.trim()}
                />
              </View>
            ))}

            <Pressable
              onPress={addKey}
              style={({ pressed }) => [styles.addBtn, pressed && styles.pressed]}
            >
              <Text style={styles.addText}>+ Add another key</Text>
            </Pressable>
          </Section>

          <Section title="Usage today">
            <View style={styles.usageRow}>
              <Stat value={formatTokens(usage?.tokens ?? 0)} label="tokens" />
              <Stat value={String(usage?.requests ?? 0)} label="requests" />
            </View>
            <Text style={styles.sectionHint}>
              Counted from what this app sent. Google does not publish remaining quota
              through the API — check AI Studio for your actual limits.
            </Text>
          </Section>

          <Section title="Google Drive">
            <Text style={styles.keyLabel}>Apps Script URL</Text>
            <TextInput
              style={styles.input}
              value={draft.driveUrl}
              onChangeText={(driveUrl) => {
                setDraft({ ...draft, driveUrl });
                setUrlCheck({ status: 'idle' });
              }}
              placeholder="https://script.google.com/macros/s/…/exec"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TestRow
              label="Test connection"
              state={urlCheck}
              onPress={testUrl}
              disabled={!draft.driveUrl.trim()}
            />

            <Text style={[styles.keyLabel, styles.spaced]}>Shared secret (optional)</Text>
            <TextInput
              style={styles.input}
              value={draft.driveSecret}
              onChangeText={(driveSecret) => setDraft({ ...draft, driveSecret })}
              placeholder="leave blank if unused"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Text style={styles.sectionHint}>
              Only needed if you set SHARED_SECRET in the Apps Script.
            </Text>
          </Section>

          <Section title="TaskNote (optional)">
            <Text style={styles.keyLabel}>TaskNote URL</Text>
            <TextInput
              style={styles.input}
              value={draft.taskNoteUrl}
              onChangeText={(taskNoteUrl) => {
                setDraft({ ...draft, taskNoteUrl });
                setTaskNoteCheck({ status: 'idle' });
              }}
              placeholder="https://tasknote.example.com"
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <TestRow
              label="Test connection"
              state={taskNoteCheck}
              onPress={testTaskNote}
              disabled={!draft.taskNoteUrl.trim()}
            />
            <Text style={styles.sectionHint}>
              When set, each meeting is also posted to TaskNote with its transcript,
              summary and Drive folder link. Leave blank to skip. A phone cannot reach{' '}
              <Text style={styles.em}>localhost</Text> — use the machine's LAN address
              (e.g. http://192.168.1.5:3000) or a deployed URL.
            </Text>
          </Section>

          <Pressable
            style={({ pressed }) => [styles.save, pressed && styles.pressed]}
            onPress={onSave}
          >
            <Text style={styles.saveText}>{saved ? 'Saved' : 'Save settings'}</Text>
          </Pressable>

          <Text style={styles.version}>VoiceToText {VERSION_LABEL}</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function TestRow(props: {
  label: string;
  state: CheckState;
  onPress: () => void;
  disabled: boolean;
}) {
  const { state } = props;
  return (
    <View style={styles.testRow}>
      <Pressable
        onPress={props.onPress}
        disabled={props.disabled || state.status === 'busy'}
        style={({ pressed }) => [styles.testButton, (props.disabled || pressed) && styles.pressed]}
      >
        {state.status === 'busy' ? (
          <ActivityIndicator color={colors.text} size="small" />
        ) : (
          <Text style={styles.testButtonText}>{props.label}</Text>
        )}
      </Pressable>
      {state.message && (
        <Text
          style={[styles.testMessage, state.status === 'ok' ? styles.ok : styles.fail]}
          numberOfLines={3}
        >
          {state.message}
        </Text>
      )}
    </View>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  body: { padding: space.lg, paddingBottom: space.xxl, gap: space.lg },
  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  sectionTitle: { ...text.h2 },
  sectionHint: { ...text.tiny, lineHeight: 18 },
  em: { color: colors.textDim, fontWeight: '700' },
  keyBlock: { gap: space.sm },
  keyHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  keyLabel: { ...text.label, fontSize: 13 },
  // The position, since that is the order the keys are tried in and what the
  // processing line means by "key 2 of 4". The name below it is the user's.
  keyIndex: { ...text.label, fontSize: 13, color: colors.textFaint },
  // Monospaced and wrapping, so a pasted key can be read character by character
  // and compared with the one in the Google console.
  keyInput: {
    fontFamily: Platform.select({ android: 'monospace', default: 'Courier' }),
    fontSize: 13,
  },
  remove: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  spaced: { marginTop: space.lg },
  input: {
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    paddingHorizontal: space.md,
    paddingVertical: 12,
    fontSize: 15,
  },
  addBtn: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    paddingVertical: 12,
    alignItems: 'center',
  },
  addText: { color: colors.link, fontSize: 14, fontWeight: '600' },
  testRow: { gap: space.sm },
  testButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: space.lg,
    paddingVertical: 7,
    minWidth: 92,
    alignItems: 'center',
  },
  testButtonText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  testMessage: { fontSize: 12, lineHeight: 18 },
  ok: { color: colors.success },
  fail: { color: '#ffb4ac' },
  usageRow: { flexDirection: 'row', gap: space.md },
  stat: {
    flex: 1,
    backgroundColor: colors.bg,
    borderRadius: radius.md,
    paddingVertical: space.lg,
    alignItems: 'center',
    gap: 2,
  },
  statValue: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  statLabel: { ...text.tiny },
  pressed: { opacity: 0.6 },
  save: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: 'center',
  },
  saveText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  version: { ...text.tiny, textAlign: 'center', marginTop: space.md },
});
