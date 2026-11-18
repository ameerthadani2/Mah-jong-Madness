/**
 * The parts every modal sheet shares: the dimmed scrim behind it, and the inert page around it on the web.
 *
 * The scrim closes the sheet on a tap, but it is no control: it is hidden from screen readers and is never a focus
 * stop, so Tab and Shift+Tab move only through the sheet's own buttons, which include the one that closes it. It is a
 * plain view with a touch responder rather than a Pressable, because React Native Web gives every Pressable a
 * tabindex, and its Modal's focus trap moves focus to any element that will take it, a tabindex of -1 included.
 */
import React, { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { holdPageInert } from '../display/inert';

export function Scrim({ onPress, testID, color = 'rgba(16,20,47,0.55)' }: { onPress: () => void; testID?: string; color?: string }) {
  return (
    <View
      testID={testID}
      style={[styles.scrim, { backgroundColor: color }]}
      onStartShouldSetResponder={() => true}
      onResponderRelease={onPress}
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    />
  );
}

/** While `open`, the page behind a dialog is inert on the web (display/inert.ts); it comes back when the dialog closes. */
export function useInertPage(open: boolean): void {
  useEffect(() => (open && Platform.OS === 'web' ? holdPageInert() : undefined), [open]);
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
});
