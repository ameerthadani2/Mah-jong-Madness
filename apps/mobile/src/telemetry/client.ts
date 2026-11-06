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

/**
 * A crash-reporting service (Sentry on a device). It runs only while the player allows it: `start`
 * is called once the stored consent has loaded with crash reports on (and again after a toggle back
 * on), `stop` when they are turned off, so native crash handling and sessions follow the toggle too.
 * It also reads `crashAllowed()` itself for errors it catches on its own.
 */
export interface CrashSink {
  capture(e: unknown, context: Record<string, string | number | boolean>): void;
  start?(): void;
  stop?(): void | Promise<void>;
}

type CrashCapture = { e: unknown; context: Record<string, string | number | boolean> };

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
  /** Errors caught before the stored consent arrived: sent or dropped once it has. */
  private crashBuffer: CrashCapture[] = [];
  private crashRunning = false;
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

  /** Sentry's own handlers ask this before sending anything they caught. Nothing leaves before the stored choice is known. */
  crashAllowed(): boolean {
    return this.opts.consent.loaded && this.opts.consent.effective.crash;
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
    if (this.opts.crash) {
      const capture = { e, context: { source, fatal } };
      // A player who turned crash reports off must not have their boot errors sent before that choice loads.
      if (!this.opts.consent.loaded) {
        if (this.crashBuffer.length < this.maxBuffer) this.crashBuffer.push(capture);
      } else if (this.crashAllowed()) this.sendCrash(capture);
    }
    this.send(errorEvent(e, source, fatal));
  }

  private sendCrash(c: CrashCapture): void {
    try {
      this.opts.crash?.capture(c.e, c.context);
    } catch {
      /* ignore */
    }
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
    // Crash reporting runs only while allowed: started here (after the stored choice loaded, or when
    // toggled on), stopped when toggled off. Errors caught before the choice loaded go the same way.
    const crashes = this.crashBuffer;
    this.crashBuffer = [];
    if (this.opts.crash) {
      if (c.crash && !this.crashRunning) {
        this.crashRunning = true;
        try {
          this.opts.crash.start?.();
        } catch {
          /* no crash reports rather than a crash */
        }
      } else if (!c.crash && this.crashRunning) {
        this.crashRunning = false;
        try {
          void Promise.resolve(this.opts.crash.stop?.()).catch(() => undefined);
        } catch {
          /* ignore */
        }
      }
      if (c.crash) for (const x of crashes) this.sendCrash(x);
    }
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
