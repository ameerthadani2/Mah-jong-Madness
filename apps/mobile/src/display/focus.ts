/**
 * Give focus back to the control that opened a dialog, once the dialog has closed: the browser's keyboard focus on
 * the web, the screen reader's focus (VoiceOver, TalkBack) on a phone. Without it a screen reader starts again at the
 * top of the screen after a dialog closes.
 */
import { AccessibilityInfo, Platform } from 'react-native';

export function returnFocus(target: unknown): void {
  if (!target) return;
  if (Platform.OS === 'web') {
    (target as { focus?: () => void }).focus?.();
    return;
  }
  AccessibilityInfo.sendAccessibilityEvent(target as Parameters<typeof AccessibilityInfo.sendAccessibilityEvent>[0], 'focus');
}
