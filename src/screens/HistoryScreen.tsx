import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { SymbolView } from 'expo-symbols';

import { deleteMeeting, listMeetings, type Meeting } from '../db';
import { formatDuration } from '../recording';
import { useProcessing, type ProcStage } from '../ProcessingContext';
import { colors, radius, space, text } from '../theme';
import MeetingDetail from './MeetingDetail';

/** Short label for the row's live processing badge. */
const PROC_LABEL: Record<ProcStage, string> = {
  queued: 'Queued…',
  starting: 'Starting…',
  transcribing: 'Transcribing…',
  summarizing: 'Summarizing…',
  uploading: 'Saving to Drive…',
  posting: 'Posting…',
  done: 'Finishing…',
};

export default function HistoryScreen() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const processing = useProcessing();

  const refresh = useCallback(async () => {
    setMeetings(await listMeetings());
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh])
  );

  // Re-read after any background retry finishes, so a row that was processing
  // while the user browsed elsewhere picks up its new transcript and tags.
  useEffect(() => {
    refresh();
  }, [processing.version, refresh]);

  // Read through the list rather than holding a copy, so a summary generated in
  // the detail view is reflected without reopening.
  const selected = meetings.find((m) => m.id === selectedId) ?? null;

  function confirmDelete(meeting: Meeting) {
    Alert.alert(
      'Delete from history?',
      'This removes the local copy only. The Drive folder stays.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteMeeting(meeting.id);
            setSelectedId(null);
            refresh();
          },
        },
      ]
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <FlatList
        data={meetings}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <View style={styles.emptyIcon}>
              <SymbolView
                name={{ ios: 'clock.arrow.circlepath', android: 'history', web: 'history' }}
                size={32}
                tintColor={colors.textDim}
              />
            </View>
            <Text style={text.h2}>No meetings yet</Text>
            <Text style={styles.emptyHint}>
              Recordings appear here once they've been transcribed.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Opens meeting details"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setSelectedId(item.id)}
            onLongPress={() => confirmDelete(item)}
          >
            <View style={styles.rowHead}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {prettyTitle(item.title)}
              </Text>
              <View style={styles.rowMeta}>
                <Text style={styles.duration}>{formatDuration(item.durationSec)}</Text>
                <SymbolView
                  name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
                  size={18}
                  tintColor={colors.textFaint}
                />
              </View>
            </View>

            <Text style={styles.rowPreview} numberOfLines={2}>
              {item.summary
                ? firstParagraph(item.summary)
                : item.transcript || item.lastError || 'Waiting to be processed.'}
            </Text>

            <View style={styles.tags}>
              {processing.stages[item.id] !== undefined ? (
                <Tag label={PROC_LABEL[processing.stages[item.id]!]} tone="accent" />
              ) : null}
              <Tag label={new Date(item.createdAt).toLocaleDateString()} />
              {item.summary ? <Tag label="Summary" tone="accent" /> : null}
              {!item.transcript && <Tag label="Not transcribed" tone="warn" />}
              {item.transcript && !item.folderUrl && <Tag label="Not in Drive" tone="warn" />}
              {item.audioPath && <Tag label="Audio on device" />}
            </View>
          </Pressable>
        )}
      />

      <Modal
        visible={!!selected}
        animationType="slide"
        onRequestClose={() => setSelectedId(null)}
      >
        {selected && (
          <MeetingDetail
            meeting={selected}
            onClose={() => setSelectedId(null)}
            onDelete={() => confirmDelete(selected)}
            onChanged={refresh}
          />
        )}
      </Modal>
    </SafeAreaView>
  );
}

function Tag({ label, tone }: { label: string; tone?: 'accent' | 'warn' }) {
  return (
    <View
      style={[
        styles.tag,
        tone === 'accent' && styles.tagAccent,
        tone === 'warn' && styles.tagWarn,
      ]}
    >
      <Text
        style={[
          styles.tagText,
          tone === 'accent' && styles.tagTextAccent,
          tone === 'warn' && styles.tagTextWarn,
        ]}
      >
        {label}
      </Text>
    </View>
  );
}

/** Titles are generated as "Meeting 2026-07-20 14:30"; drop the noise word. */
function prettyTitle(title: string): string {
  return title.replace(/^Meeting\s+/, '');
}

/** Skips the "OVERVIEW" heading so the preview shows actual content. */
function firstParagraph(summary: string): string {
  return summary
    .split('\n')
    .filter((line) => line.trim() && !/^[A-Z ]{4,}$/.test(line.trim()))
    .join(' ');
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  list: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    gap: 14,
    paddingBottom: space.xxl,
  },
  empty: { alignItems: 'center', marginTop: 96, gap: space.sm },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.sm,
  },
  emptyHint: { ...text.meta, textAlign: 'center', paddingHorizontal: 40 },
  row: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: '#192231',
    paddingHorizontal: space.lg,
    paddingVertical: 18,
    gap: 10,
  },
  rowPressed: { backgroundColor: colors.surfaceAlt },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rowTitle: { ...text.h2, flex: 1, fontSize: 18, lineHeight: 24 },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  duration: {
    ...text.tiny,
    fontVariant: ['tabular-nums'],
    color: colors.textDim,
  },
  rowPreview: { fontSize: 14, lineHeight: 22, color: colors.textDim },
  tags: { flexDirection: 'row', gap: 6, marginTop: space.xs, flexWrap: 'wrap' },
  tag: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  tagAccent: { backgroundColor: colors.accentSoft },
  tagWarn: { backgroundColor: colors.dangerSoft },
  tagText: { fontSize: 11, fontWeight: '600', color: colors.textDim },
  tagTextAccent: { color: colors.link },
  tagTextWarn: { color: '#ffb4ac' },
});
