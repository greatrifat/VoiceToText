import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, text } from '../theme';

export type StepState = 'pending' | 'active' | 'done' | 'failed';

export type Step = { key: string; label: string; state: StepState };

/**
 * A visible checklist rather than a bare spinner: transcription can run for a
 * minute or more on a long meeting, and an undifferentiated spinner gives no
 * signal about whether anything is still happening or which stage stalled.
 */
export default function ProcessingSteps({ steps }: { steps: Step[] }) {
  return (
    <View style={styles.card}>
      {steps.map((step, index) => (
        <View key={step.key} style={styles.row}>
          <View style={styles.railColumn}>
            <Marker state={step.state} />
            {index < steps.length - 1 && (
              <View
                style={[styles.rail, step.state === 'done' && styles.railDone]}
              />
            )}
          </View>
          <Text
            style={[
              styles.label,
              step.state === 'pending' && styles.labelPending,
              step.state === 'active' && styles.labelActive,
              step.state === 'failed' && styles.labelFailed,
            ]}
          >
            {step.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Marker({ state }: { state: StepState }) {
  if (state === 'active') {
    return (
      <View style={[styles.marker, styles.markerActive]}>
        <ActivityIndicator size="small" color={colors.accent} />
      </View>
    );
  }
  if (state === 'done') {
    return (
      <View style={[styles.marker, styles.markerDone]}>
        <Text style={styles.markerGlyph}>✓</Text>
      </View>
    );
  }
  if (state === 'failed') {
    return (
      <View style={[styles.marker, styles.markerFailed]}>
        <Text style={styles.markerGlyph}>!</Text>
      </View>
    );
  }
  return <View style={[styles.marker, styles.markerPending]} />;
}

const MARKER = 28;

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.xl,
    gap: 0,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: space.lg },
  railColumn: { alignItems: 'center', width: MARKER },
  marker: {
    width: MARKER,
    height: MARKER,
    borderRadius: MARKER / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markerPending: { borderWidth: 2, borderColor: colors.border },
  markerActive: { backgroundColor: colors.accentSoft },
  markerDone: { backgroundColor: colors.accent },
  markerFailed: { backgroundColor: colors.danger },
  markerGlyph: { color: '#fff', fontSize: 15, fontWeight: '800' },
  rail: { width: 2, height: 26, backgroundColor: colors.border, marginVertical: 2 },
  railDone: { backgroundColor: colors.accent },
  label: { ...text.label, paddingTop: 5, flex: 1 },
  labelPending: { color: colors.textFaint, fontWeight: '500' },
  labelActive: { color: colors.text },
  labelFailed: { color: colors.danger },
});
