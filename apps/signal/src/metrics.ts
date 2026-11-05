/**
 * In-process metrics for `/health`: a sliding window of durations with percentiles. Kept small
 * and dependency-free; anything longer-term belongs in Sentry, PostHog or Fly's metrics.
 */

export interface LatencySummary {
  /** Samples in the window. */
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  windowSeconds: number;
}

/** Durations recorded over the last `windowMs` (default five minutes), capped at `maxSamples`. */
export class LatencyWindow {
  private readonly at: number[] = [];
  private readonly ms: number[] = [];
  private head = 0;
  constructor(
    private readonly opts: { windowMs?: number; maxSamples?: number; now?: () => number } = {},
  ) {}

  private get windowMs(): number {
    return this.opts.windowMs ?? 5 * 60_000;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.at.push(this.now());
    this.ms.push(durationMs);
    const max = this.opts.maxSamples ?? 20_000;
    if (this.at.length - this.head > max) this.head = this.at.length - max;
    this.compact();
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.head < this.at.length && this.at[this.head] < cutoff) this.head++;
    this.compact();
  }

  /** Drop consumed entries once they are half the arrays, so memory stays bounded. */
  private compact(): void {
    if (this.head > 1024 && this.head * 2 > this.at.length) {
      this.at.splice(0, this.head);
      this.ms.splice(0, this.head);
      this.head = 0;
    }
  }

  summary(): LatencySummary {
    this.prune();
    const values = this.ms.slice(this.head).sort((a, b) => a - b);
    const pick = (q: number) => (values.length ? round(values[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)]) : null);
    return { samples: values.length, p50Ms: pick(0.5), p95Ms: pick(0.95), maxMs: values.length ? round(values[values.length - 1]) : null, windowSeconds: Math.round(this.windowMs / 1000) };
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
