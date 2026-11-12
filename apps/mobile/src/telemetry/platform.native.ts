/**
 * Telemetry back ends on iOS and Android: Sentry for crash reports, PostHog for product analytics.
 * Each starts only when its key is baked into the build (src/config.ts); otherwise nothing loads.
 */
import * as Sentry from '@sentry/react-native';
import PostHog from 'posthog-react-native';
import type { TelemetryPlatform } from './platform';

let sentryStarted = false;
/** A DSN is baked into this build, so crash reports may start now or later, when the player agrees. */
let crashConfigured = false;

interface ErrorUtilsLike {
  getGlobalHandler(): (e: unknown, fatal?: boolean) => void;
  setGlobalHandler(h: (e: unknown, fatal?: boolean) => void): void;
}

export const telemetryPlatform: TelemetryPlatform = {
  createCrash(dsn, allowed) {
    if (!dsn) return null;
    crashConfigured = true;
    // Sentry starts only from `start()`: once the stored consent has loaded with crash reports on. The JS
    // `beforeSend` below never reaches the native SDK (it is stripped before initNativeSdk), so native crash
    // handling and auto sessions can only be switched off by not initialising, and `stop()` closes the SDK
    // when the player turns the toggle off.
    const start = () => {
      if (sentryStarted) return;
      Sentry.init({
        dsn,
        environment: __DEV__ ? 'development' : 'production',
        // No IP addresses, user names or request bodies: reports identify a build, not a player.
        sendDefaultPii: false,
        tracesSampleRate: 0,
        // Sessions are usage telemetry, not crash data: never tracked.
        enableAutoSessionTracking: false,
        // A second check for the JS-side reports (Sentry's own handlers included) in case the toggle flips mid-flight.
        beforeSend: (event) => (allowed() ? event : null),
        beforeBreadcrumb: (crumb) => (crumb.category === 'console' ? null : crumb),
      });
      sentryStarted = true;
    };
    const stop = async () => {
      if (!sentryStarted) return;
      sentryStarted = false;
      await Sentry.close();
    };
    return {
      capture: (e, context) => {
        if (sentryStarted) Sentry.captureException(e, { tags: context });
      },
      start,
      stop,
    };
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

  // The root is wrapped once, when the app registers it, which is before the stored consent has loaded and long
  // before a new player answers the question: so it is wrapped whenever this build can report crashes at all.
  // Until `start()` runs there is no Sentry client, and the wrapper's touch breadcrumbs and profiler do nothing
  // without one (@sentry/core addBreadcrumb and the profiler both return when getClient() is empty): nothing is
  // recorded or sent before the player has agreed.
  wrapRoot: (root) => (crashConfigured ? Sentry.wrap(root) : root),
};
