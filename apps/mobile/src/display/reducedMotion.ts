/**
 * The system "reduce motion" setting (iOS Reduce Motion, Android Remove animations, the browser's
 * prefers-reduced-motion on web), read once and kept current with the change listener, shared by every
 * animated component without a provider: `useReducedMotion()`.
 *
 * With it on, the table shows end states instead of motion: discards appear in place, the winner's hand is
 * face up at once, call-outs and seat reactions show and hide without springing, numbers do not roll, and win
 * celebrations draw a single still frame.
 */
import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';
import { createMotionPreference, type MotionSource } from './motionPreference';

const source: MotionSource = {
  read: () => AccessibilityInfo.isReduceMotionEnabled(),
  listen: (on) => {
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', on);
    return () => sub?.remove?.();
  },
};

const pref = createMotionPreference(source);

/** True while the player asks the system for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(pref.subscribe, pref.get, pref.get);
}

/** The current value outside React (false until the first read answers). */
export function reducedMotionNow(): boolean {
  return pref.get();
}
