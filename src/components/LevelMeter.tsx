import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View } from 'react-native';

import { colors } from '../theme';

const BAR_COUNT = 32;

/**
 * Live input level, so a silent-looking screen can be distinguished from a
 * recorder that has actually stopped picking up audio. `metering` is dBFS —
 * roughly -60 (silence) to 0 (clipping).
 */
export default function LevelMeter({
  metering,
  active,
}: {
  metering?: number;
  active: boolean;
}) {
  const level = typeof metering === 'number' ? clamp((metering + 60) / 60) : 0;

  return (
    <View style={styles.row}>
      {Array.from({ length: BAR_COUNT }).map((_, index) => (
        <Bar key={index} index={index} level={active ? level : 0} active={active} />
      ))}
    </View>
  );
}

function Bar({ index, level, active }: { index: number; level: number; active: boolean }) {
  // Bars near the centre react most, giving a symmetric shape rather than a
  // flat block that reads as a progress bar.
  const distance = Math.abs(index - (BAR_COUNT - 1) / 2) / ((BAR_COUNT - 1) / 2);
  const weight = 1 - distance * 0.75;
  const target = 4 + level * 44 * weight;

  const height = useRef(new Animated.Value(4)).current;

  useEffect(() => {
    Animated.timing(height, {
      toValue: target,
      duration: 110,
      useNativeDriver: false,
    }).start();
  }, [target, height]);

  return (
    <Animated.View
      style={[styles.bar, { height }, !active && styles.barIdle]}
    />
  );
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    gap: 3,
  },
  bar: { width: 3, borderRadius: 2, backgroundColor: colors.accent },
  barIdle: { backgroundColor: colors.border },
});
