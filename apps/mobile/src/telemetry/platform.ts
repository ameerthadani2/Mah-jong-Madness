/**
 * The telemetry back ends on the web (and the type both platforms implement): none. The web
 * build is the preview and the e2e target, so it never loads Sentry or PostHog.
 * iOS and Android use ./platform.native.ts instead (Metro picks it by file extension).
 */
import type React from 'react';
import type { AnalyticsSink, CrashSink } from './client';

export interface TelemetryPlatform {
  /** Starts crash reporting when a DSN is set; `allowed` is asked before each report leaves the device. */
  createCrash(dsn: string | undefined, allowed: () => boolean): CrashSink | null;
  /** A factory for the analytics client when a key is set (it is only called once analytics are allowed). */
  createAnalytics(key: string | undefined, host: string): (() => AnalyticsSink) | null;
  /** Calls `onError` for every uncaught error, after any handler already installed has been kept. */
  installUnhandled(onError: (e: unknown, fatal: boolean) => void): void;
  /** Wraps the root component for crash breadcrumbs (no-op without crash reporting). */
  wrapRoot<P extends Record<string, unknown>>(root: React.ComponentType<P>): React.ComponentType<P>;
}

export const telemetryPlatform: TelemetryPlatform = {
  createCrash: () => null,
  createAnalytics: () => null,
  installUnhandled: () => undefined,
  wrapRoot: (root) => root,
};
