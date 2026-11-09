/**
 * Error reporting and product analytics for the server, both optional.
 *
 * - Sentry (`@sentry/node`) starts only when SENTRY_DSN is set (`initSentry`, called from
 *   main.ts). Handlers report through `reportError`, which is a no-op until a reporter is set, so
 *   tests and servers without a DSN never load the SDK.
 * - PostHog (`posthog-node`) captures a few server-side events (`purchase_credited`,
 *   `report_filed`) only when POSTHOG_KEY is set (`createAnalytics`); otherwise `NO_ANALYTICS`.
 *   Wrapped in `withConsent`, an event is sent only for a player who allowed analytics in the app.
 *
 * Neither ever receives names, emails, chat or tokens: events carry the user id (an opaque uuid)
 * and the few properties listed in docs/OBSERVABILITY.md.
 */

type Env = Record<string, string | undefined>;

export interface ErrorReporter {
  capture(error: unknown, context?: Record<string, unknown>): void;
}

let reporter: ErrorReporter | null = null;

/** Install (or with null remove) the process-wide error reporter. */
export function setErrorReporter(r: ErrorReporter | null): void {
  reporter = r;
}

/** Report an unexpected error (an API 500, a socket handler throw, a failed tick). Never throws. */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  if (!reporter) return;
  try {
    reporter.capture(error, context);
  } catch {
    /* reporting must never take the server down */
  }
}

/** The part of `@sentry/node` the server uses. */
export interface SentryLike {
  init(options: Record<string, unknown>): unknown;
  captureException(error: unknown, hint?: { extra?: Record<string, unknown> }): unknown;
  flush(timeoutMs?: number): Promise<boolean>;
}

/**
 * Start Sentry when SENTRY_DSN is set and route `reportError` to it. Returns the SDK (to flush on
 * shutdown) or null when there is no DSN. `load` is injectable for tests.
 */
export async function initSentry(env: Env, load: () => Promise<SentryLike> = () => import('@sentry/node') as unknown as Promise<SentryLike>): Promise<SentryLike | null> {
  const dsn = (env.SENTRY_DSN ?? '').trim();
  if (!dsn) return null;
  const sentry = await load();
  sentry.init({
    dsn,
    environment: (env.SENTRY_ENVIRONMENT ?? '').trim() || 'production',
    release: (env.SENTRY_RELEASE ?? env.FLY_IMAGE_REF ?? '').trim() || undefined,
    // Errors only: no performance tracing and no request bodies or headers.
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
  setErrorReporter({ capture: (error, context) => sentry.captureException(error, context ? { extra: context } : undefined) });
  return sentry;
}

export interface Analytics {
  readonly enabled: boolean;
  capture(distinctId: string, event: string, properties?: Record<string, unknown>): void;
  shutdown(): Promise<void>;
}

export const NO_ANALYTICS: Analytics = { enabled: false, capture: () => {}, shutdown: async () => {} };

/**
 * Analytics that only reach `inner` for players who allowed them: `consented(userId)` is asked
 * for every event (the app sends the choice with `PATCH /api/me`; no answer counts as no). A
 * failed lookup drops the event.
 */
export function withConsent(inner: Analytics, consented: (distinctId: string) => Promise<boolean | null>): Analytics {
  if (!inner.enabled) return inner;
  return {
    enabled: true,
    capture(distinctId, event, properties) {
      void consented(distinctId).then(
        (ok) => {
          if (ok === true) inner.capture(distinctId, event, properties);
        },
        () => {},
      );
    },
    shutdown: () => inner.shutdown(),
  };
}

/** The part of `posthog-node`'s client the server uses. */
export interface PostHogLike {
  capture(message: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  shutdown(): Promise<void> | void;
}

type PostHogCtor = new (apiKey: string, options: { host?: string; flushAt?: number; flushInterval?: number }) => PostHogLike;

/** PostHog when POSTHOG_KEY is set (POSTHOG_HOST optional), otherwise `NO_ANALYTICS`. */
export async function createAnalytics(env: Env, load: () => Promise<PostHogCtor> = async () => (await import('posthog-node')).PostHog as unknown as PostHogCtor): Promise<Analytics> {
  const key = (env.POSTHOG_KEY ?? '').trim();
  if (!key) return NO_ANALYTICS;
  const PostHog = await load();
  const host = (env.POSTHOG_HOST ?? '').trim() || undefined;
  const client = new PostHog(key, { host, flushAt: 20, flushInterval: 10_000 });
  return {
    enabled: true,
    capture(distinctId, event, properties) {
      try {
        client.capture({ distinctId, event, properties: { ...properties, source: 'server' } });
      } catch (e) {
        reportError(e, { where: 'analytics' });
      }
    },
    async shutdown() {
      await client.shutdown();
    },
  };
}
