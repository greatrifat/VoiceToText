import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, text } from '../theme';

type Line = {
  time: string | null;
  speaker: string | null;
  body: string;
};

const TIMESTAMP = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/;
// Speaker labels are short; the length cap stops a sentence containing a colon
// from being mistaken for one.
const SPEAKER = /^([^:]{1,32}):\s*(.*)$/;

export function parseTranscript(transcript: string): Line[] {
  return transcript
    .split('\n')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      let rest = raw;
      let time: string | null = null;

      const stamped = rest.match(TIMESTAMP);
      if (stamped) {
        time = stamped[1];
        rest = stamped[2];
      }

      const labelled = rest.match(SPEAKER);
      if (labelled) {
        return { time, speaker: labelled[1], body: labelled[2] };
      }
      return { time, speaker: null, body: rest };
    });
}

/**
 * Renders `[MM:SS] Speaker 1: …` as columns. Falls back to plain paragraphs for
 * transcripts recorded before timestamps existed, so old meetings still read
 * correctly rather than showing a broken layout.
 */
export default function TranscriptView({ transcript }: { transcript: string }) {
  const lines = parseTranscript(transcript);
  const hasTimestamps = lines.some((line) => line.time);

  if (!hasTimestamps) {
    return (
      <Text style={text.body} selectable>
        {transcript}
      </Text>
    );
  }

  let previousSpeaker: string | null = null;

  return (
    <View style={styles.list}>
      {lines.map((line, index) => {
        const showSpeaker = line.speaker !== null && line.speaker !== previousSpeaker;
        previousSpeaker = line.speaker;
        return (
          <View key={index} style={styles.row}>
            <Text style={styles.time} selectable>
              {line.time ?? ''}
            </Text>
            <View style={styles.content}>
              {showSpeaker && <Text style={styles.speaker}>{line.speaker}</Text>}
              <Text style={text.body} selectable>
                {line.body}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.lg },
  row: { flexDirection: 'row', gap: space.md },
  time: {
    width: 52,
    paddingTop: 3,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    color: colors.textFaint,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    paddingVertical: 2,
    textAlign: 'center',
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  content: { flex: 1, gap: 2 },
  speaker: { color: colors.link, fontSize: 13, fontWeight: '700' },
});
