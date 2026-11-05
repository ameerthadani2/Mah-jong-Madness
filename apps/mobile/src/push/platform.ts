/**
 * Notifications on the web (and the type both platforms implement): unsupported, every call a
 * no-op. iOS and Android use ./platform.native.ts (Metro picks it by file extension).
 */
import type { PushPlatform } from './registration';

export interface PushDevice extends PushPlatform {
  supported: boolean;
  /** Sets up foreground presentation (and the Android channel); `present` decides per notification `data`. */
  configure(present: (data: unknown) => boolean, channelName: string): void;
  /** Taps on a notification, including the one that launched the app; called with its `data`. */
  onOpen(cb: (data: unknown) => void): () => void;
  /** The system issued a new push token. */
  onTokenRotated(cb: () => void): () => void;
}

export const pushDevice: PushDevice = {
  supported: false,
  getPermission: async () => ({ status: 'denied', canAskAgain: false }),
  requestPermission: async () => 'denied',
  getToken: async () => null,
  configure: () => undefined,
  onOpen: () => () => undefined,
  onTokenRotated: () => () => undefined,
};
