/**
 * The one telemetry API the app calls: `track(event, props)` for the funnel and `captureError`
 * for failures. Pure TypeScript: the analytics and crash back ends are injected (PostHog and
 * Sentry on a device, nothing on the web or in tests), and every call is gated on consent.
 *
 * With no back end configured every call is a no-op; nothing here ever throws into the app.
 */
import { errorEvent, type EventName, type EventProps, type TelemetryEvent } from './events';
import type { ConsentStore, EffectiveConsent } from './consent';

/** A product-analytics service (PostHog on a device). */
export interface AnalyticsSink {
  capture(name: string, props: Record<string, unknown>): void;
  optIn(): void;
  optOut(): void;
}

/** A crash-reporting service (Sentry on a device). It reads `crashAllowed()` itself for errors it catches on its own. */
export interface CrashSink {
  capture(e: unknown, context: Record<string, string | number | boolean>): void;
}

export interface TelemetryOptions {
  consent: ConsentStore;
  /** Created the first time analytics are allowed; null when no key is configured. */
  analytics?: (() => AnalyticsSink | null) | null;
  crash?: CrashSink | null;
  /** Events kept while the stored consent is still loading. */
  maxBuffer?: number;
}

export class Telemetry {
  private sink: AnalyticsSink | null = null;
  private optedOut = false;
  private buffer: TelemetryEvent[] = [];
  private readonly maxBuffer: number;

  constructor(private readonly opts: TelemetryOptions) {
    this.maxBuffer = opts.maxBuffer ?? 50;
    opts.consent.subscribe((c) => this.onConsent(c));
    if (opts.consent.loaded) this.onConsent(opts.consent.effective);
  }

  /** Which services this build has keys for (the privacy toggles show only these). */
  get available(): { analytics: boolean; crash: boolean } {
    return { analytics: !!this.opts.analytics, crash: !!this.opts.crash };
  }

  /** Sentry's own handlers ask this before sending anything they caught. */
  crashAllowed(): boolean {
    return this.opts.consent.effective.crash;
  }

  track<E extends EventName>(name: E, props: EventProps[E]): void {
    this.send({ name, props } as TelemetryEvent);
  }

  send(e: TelemetryEvent): void {
    if (!this.opts.analytics) return;
    if (!this.opts.consent.loaded) {
      if (this.buffer.length < this.maxBuffer) this.buffer.push(e);
      return;
    }
    if (!this.opts.consent.effective.analytics) return;
    const sink = this.ensureSink();
    try {
      sink?.capture(e.name, e.props as Record<string, unknown>);
    } catch {
      /* analytics must never break the app */
    }
  }

  /** Report a failure the app caught (the boot check, a rejected promise it handled) and count it in the funnel. */
  captureError(e: unknown, source: EventProps['error']['source'], fatal = false): void {
    if (this.opts.crash && this.crashAllowed()) {
      try {
        this.opts.crash.capture(e, { source, fatal });
      } catch {
        /* ignore */
      }
    }
    this.send(errorEvent(e, source, fatal));
  }

  private ensureSink(): AnalyticsSink | null {
    if (!this.sink && this.opts.analytics) {
      try {
        this.sink = this.opts.analytics();
      } catch {
        this.sink = null;
      }
    }
    return this.sink;
  }

  private onConsent(c: EffectiveConsent): void {
    const queued = this.buffer;
    this.buffer = [];
    if (c.analytics) {
      if (this.sink && this.optedOut) {
        this.sink.optIn();
        this.optedOut = false;
      }
      for (const e of queued) this.send(e);
    } else if (this.sink && !this.optedOut) {
      this.sink.optOut();
      this.optedOut = true;
    }
  }
}
