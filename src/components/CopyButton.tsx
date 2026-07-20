import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { colors, radius, space } from '../theme';

/**
 * Text is selectable everywhere, but dragging a selection across a long
 * transcript on a phone is miserable — this copies the whole thing in one tap.
 */
export default function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await Clipboard.setStringAsync(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Pressable
      onPress={copy}
      hitSlop={8}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={[styles.text, copied && styles.copied]}>
        {copied ? '✓ Copied' : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  pressed: { opacity: 0.6 },
  text: { color: colors.link, fontSize: 12, fontWeight: '700' },
  copied: { color: colors.success },
});
