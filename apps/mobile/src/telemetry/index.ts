/**
 * The app's telemetry: `track(event, props)` for the funnel, `captureError` for failures, and the
 * player's privacy choices. Starts when first imported (from App.tsx). Both services are opt-in: nothing
 * is captured or sent until the player has said yes (the one-time question after the age gate, or the
 * switches in Settings), and crash reporting itself begins only then. With no keys in the build every
 * call is a no-op.
 *
 *   track('purchase_start', { product: 'diamonds_120' })
 *   markConsentGiven({ minor: false })   // from the first-run age gate
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { POSTHOG_HOST, POSTHOG_KEY, SENTRY_DSN } from '../config';
import { ConsentStore, type ConsentRecord, type EffectiveConsent } from './consent';
import { Telemetry } from './client';
import { errorEvent, type EventName, type EventProps, type TelemetryEvent } from './events';
import { telemetryPlatform } from './platform';

export { type EventName, type EventProps, type TelemetryEvent } from './events';

export const consent = new ConsentStore({
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
});

const crash = telemetryPlatform.createCrash(SENTRY_DSN, () => telemetry.crashAllowed());
export const telemetry = new Telemetry({ consent, crash, analytics: telemetryPlatform.createAnalytics(POSTHOG_KEY, POSTHOG_HOST) });
// Sentry's handler (installed when crash reports start) keeps this one: Sentry reports the crash, this counts it.
telemetryPlatform.installUnhandled((e, fatal) => telemetry.send(errorEvent(e, 'unhandled', fatal)));
void consent.load();

export function track<E extends EventName>(name: E, props: EventProps[E]): void {
  telemetry.track(name, props);
}

export function trackAll(events: TelemetryEvent[]): void {
  for (const e of events) telemetry.send(e);
}

export function captureError(e: unknown, source: EventProps['error']['source'] = 'caught', fatal = false): void {
  telemetry.captureError(e, source, fatal);
}

/** The first-run age gate calls this once the player has confirmed it; a minor is never asked to share anything. */
export function markConsentGiven(o: { minor?: boolean } = {}): void {
  consent.dispatch({ type: 'given', minor: o.minor });
}

export const wrapRoot = telemetryPlatform.wrapRoot;

/** Which services this build has keys for. */
export const telemetryAvailable = telemetry.available;

let snapshot: { effective: EffectiveConsent; record: ConsentRecord; loaded: boolean } = { effective: consent.effective, record: consent.current, loaded: consent.loaded };
const listeners = new Set<() => void>();
consent.subscribe((effective, record) => {
  snapshot = { effective, record, loaded: consent.loaded };
  for (const l of listeners) l();
});

/** The player's privacy choices, re-rendering when they change. */
export function useConsent(): { effective: EffectiveConsent; record: ConsentRecord; /** The stored choice has been read. */ loaded: boolean } {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}
