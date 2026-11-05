/**
 * Notifications on iOS and Android through expo-notifications. Expo push tokens need the EAS
 * project id (absent → no token, push stays off) and a physical device.
 */
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { EAS_PROJECT_ID } from '../config';
import type { PermissionStatus } from './registration';
import type { PushDevice } from './platform';

const CHANNEL_ID = 'default';
/** Notifications already acted on this launch (a remounted listener must not follow one twice). */
const handled = new Set<string>();

function statusOf(p: Notifications.NotificationPermissionsStatus): PermissionStatus {
  if (p.granted || p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL || p.ios?.status === Notifications.IosAuthorizationStatus.EPHEMERAL) return 'granted';
  return p.status === 'undetermined' ? 'undetermined' : 'denied';
}

export const pushDevice: PushDevice = {
  supported: true,

  async getPermission() {
    const p = await Notifications.getPermissionsAsync();
    return { status: statusOf(p), canAskAgain: p.canAskAgain };
  },

  async requestPermission() {
    return statusOf(await Notifications.requestPermissionsAsync());
  },

  async getToken() {
    if (!EAS_PROJECT_ID || !Device.isDevice) return null;
    const t = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
    return t.data || null;
  },

  configure(present, channelName) {
    Notifications.setNotificationHandler({
      handleNotification: async (n) => {
        const show = present(n.request.content.data);
        return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
      },
    });
    if (Platform.OS === 'android') {
      void Notifications.setNotificationChannelAsync(CHANNEL_ID, { name: channelName, importance: Notifications.AndroidImportance.HIGH }).catch(() => undefined);
    }
  },

  onOpen(cb) {
    let live = true;
    const handle = (r: Notifications.NotificationResponse | null) => {
      if (!live || !r || r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = r.notification.request.identifier;
      if (handled.has(id)) return;
      handled.add(id);
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
      cb(r.notification.request.content.data);
    };
    // The tap that launched the app arrives before any listener could be added.
    void Notifications.getLastNotificationResponseAsync().then(handle, () => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    return () => {
      live = false;
      sub.remove();
    };
  },

  onTokenRotated(cb) {
    const sub = Notifications.addPushTokenListener(() => cb());
    return () => sub.remove();
  },
};
