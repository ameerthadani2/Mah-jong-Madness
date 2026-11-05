/**
 * Telemetry back ends on iOS and Android: Sentry for crash reports, PostHog for product analytics.
 * Each starts only when its key is baked into the build (src/config.ts); otherwise nothing loads.
 */
import * as Sentry from '@sentry/react-native';
import PostHog from 'posthog-react-native';
import type { TelemetryPlatform } from './platform';

let sentryStarted = false;

interface ErrorUtilsLike {
  getGlobalHandler(): (e: unknown, fatal?: boolean) => void;
  setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void;
}

export const telemetryPlatform: TelemetryPlatform = {
  createCrash(dsn, allowed) {
    if (!dsn) return null;
    try {
      Sentry.init({
        dsn,
        environment: __DEV__ ? 'development' : 'production',
        // No IP addresses, user names or request bodies: reports identify a build, not a player.
        sendDefaultPii: false,
        tracesSampleRate: 0,
        // Checked for every report, including the ones Sentry's own handlers catch, so the toggle is immediate.
        beforeSend: (event) => (allowed() ? event : null),
        beforeBreadcrumb: (crumb) => (crumb.category === 'console' ? null : crumb),
      });
      sentryStarted = true;
    } catch {
      return null;
    }
    return { capture: (e, context) => void Sentry.captureException(e, { tags: context }) };
  },

  createAnalytics(key, host) {
    if (!key) return null;
    return () => {
      const ph = new PostHog(key, {
        host,
        // app_open is sent by the app itself; nothing is recorded or identified automatically.
        captureAppLifecycleEvents: false,
        enableSessionReplay: false,
        personProfiles: 'never',
      });
      return {
        capture: (name, props) => void ph.capture(name, props as Parameters<PostHog['capture']>[1]),
        optIn: () => void ph.optIn(),
        optOut: () => void ph.optOut(),
      };
    };
  },

  installUnhandled(onError) {
    const eu = (globalThis as unknown as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
    if (!eu) return;
    const previous = eu.getGlobalHandler();
    eu.setGlobalHandler((e, fatal) => {
      try {
        onError(e, !!fatal);
      } catch {
        /* never mask the original error */
      }
      previous?.(e, fatal);
    });
  },

  wrapRoot: (root) => (sentryStarted ? Sentry.wrap(root) : root),
};
