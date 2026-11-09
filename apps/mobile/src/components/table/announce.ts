/**
 * Spoken announcements for the table. Android reads `accessibilityLiveRegion` on its own, but iOS ignores that
 * prop, so call-outs, the connection banners and the auto-discard notice are also announced on iOS with
 * AccessibilityInfo.announceForAccessibility. (Only on iOS: Android would read them twice.)
 */
import { useEffect } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';
import { announcesOn } from './announcePolicy';

export function announce(message: string | null | undefined): void {
  if (!message || !announcesOn(Platform.OS)) return;
  AccessibilityInfo.announceForAccessibility(message);
}

/** Announces `message` whenever it (or `key`, for the same words twice) changes. */
export function useAnnounce(message: string | null | undefined, key?: unknown): void {
  useEffect(() => {
    announce(message);
  }, [message, key]);
}
