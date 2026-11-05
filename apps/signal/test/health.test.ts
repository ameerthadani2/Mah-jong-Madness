/**
 * Observability: the latency window behind `/health`, `/health` itself after real table actions,
 * and the optional Sentry and PostHog hooks (off without their keys, wired when given fakes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseAction, legalActions } from '@mjm/engine';
import { TableClient, type HostMessage, type Link } from '@mjm/net';
import { LatencyWindow } from '../src/metrics';
import { createAnalytics, initSentry, NO_ANALYTICS, reportError, setErrorReporter, type SentryLike } from '../src/observability';
import type { Socket } from '../src/rooms';
import type { WalletService } from '../src/wallet';
import { apiFixture } from './helpers';

afterEach(() => setErrorReporter(null));

describe('LatencyWindow', () => {
  it('reports p50, p95 and max over the last five minutes only', () => {
    let t = 0;
    const w = new LatencyWindow({ now: () => t });
    expect(w.summary()).toEqual({ samples: 0, p50Ms: null, p95Ms: null, maxMs: null, windowSeconds: 300 });
    for (let i = 1; i <= 100; i++) w.record(i);
    expect(w.summary()).toEqual({ samples: 100, p50Ms: 50, p95Ms: 95, maxMs: 100, windowSeconds: 300 });
    t = 4 * 60_000;
    w.record(1000);
    t = 5 * 60_000 + 1; // the first hundred are now older than five minutes
    expect(w.summary()).toMatchObject({ samples: 1, p95Ms: 1000 });
    w.record(-1);
    w.record(Number.NaN);
    expect(w.summary().samples).toBe(1);
  });

  it('keeps at most maxSamples, dropping the oldest', () => {
    const w = new LatencyWindow({ maxSamples: 10, now: () => 0 });
    for (let i = 0; i < 5000; i++) w.record(i);
    expect(w.summary()).toMatchObject({ samples: 10, p50Ms: 4994, maxMs: 4999 });
  });
});

describe('/health', () => {
  it('reports tables, peers, storage and the p95 action-to-state latency of real moves', () => {
    let perf = 0;
    const latency = new LatencyWindow();
    const f = apiFixture({ rooms: { botDelayMs: 0, actionLatency: latency, perfNow: () => (perf += 2) }, deps: { actionLatency: latency } });
    const code = f.rooms.createHostedRoom();
    const handlers = new Set<(m: HostMessage) => void>();
    const socket: Socket = {
      send: (j) => {
        const m = JSON.parse(j) as { t: string; data?: { ch?: string; msg?: unknown } };
        if (m.t === 'from' && m.data?.ch === 'game') for (const h of handlers) h(m.data.msg as HostMessage);
      },
      close: () => undefined,
    };
    const id = f.rooms.hello(f.rooms.connect(socket), 'user-alice-1');
    f.rooms.handle(id, { t: 'join', room: code });
    const link: Link = {
      send: (msg) => f.rooms.handle(id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg } }),
      onMessage: (cb) => (handlers.add(cb), () => handlers.delete(cb)),
      close: () => f.rooms.disconnect(id),
    };
    const client = new TableClient(link, 'Alice');
    client.join();
    const host = f.rooms.hostedTable(code)!;
    host.start();
    let moves = 0;
    while (host.phase === 'playing' && moves < 500) {
      const s = client.localState();
      if (!s || client.state.seat === null || legalActions(s, client.state.seat).length === 0) break;
      client.act(chooseAction(s, client.state.seat)!);
      moves++;
    }
    expect(moves).toBeGreaterThan(0);
    return f.call('GET', '/health').then((res) => {
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ ok: true, peers: 1, rooms: 1, hostedTables: 1, tables: 1, storage: 'memory', pushEnabled: false, storeEnabled: false });
      // Only `action` frames are timed (not join, ready or chat), each 2 ms on the fake clock.
      expect(res.json.actionLatency).toEqual({ samples: moves, p50Ms: 2, p95Ms: 2, maxMs: 2, windowSeconds: 300 });
    });
  });

  it('reports a null latency when nothing measures it, and db down when the check fails', async () => {
    const f = apiFixture({ deps: { healthy: async () => false } });
    const res = await f.call('GET', '/health');
    expect(res.json).toMatchObject({ actionLatency: null, db: 'down' });
  });
});

describe('error reporting', () => {
  it('reports an API 500 with its route, and never throws itself', async () => {
    const captured: Array<{ error: unknown; context?: Record<string, unknown> }> = [];
    setErrorReporter({ capture: (error, context) => captured.push({ error, context }) });
    const broken = { summary: async () => Promise.reject(new Error('wallet store away')) } as unknown as WalletService;
    const f = apiFixture({ deps: { wallet: broken } });
    const g = await f.guest();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await f.call('GET', '/api/me', undefined, g.auth);
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(captured).toHaveLength(1);
    expect((captured[0].error as Error).message).toBe('wallet store away');
    expect(String(captured[0].context?.route)).toContain('api');
    setErrorReporter({
      capture: () => {
        throw new Error('reporter broken');
      },
    });
    expect(() => reportError(new Error('x'))).not.toThrow();
  });

  it('starts Sentry only with SENTRY_DSN, errors only and without personal data', async () => {
    const load = vi.fn();
    expect(await initSentry({}, load)).toBeNull();
    expect(load).not.toHaveBeenCalled();
    reportError(new Error('nobody listens')); // no reporter: a no-op

    const calls: { init?: Record<string, unknown>; captured: unknown[] } = { captured: [] };
    const fake: SentryLike = {
      init: (o) => (calls.init = o),
      captureException: (e) => calls.captured.push(e),
      flush: async () => true,
    };
    expect(await initSentry({ SENTRY_DSN: ' https://key@o1.ingest.sentry.io/2 ', FLY_IMAGE_REF: 'registry/app:v42' }, async () => fake)).toBe(fake);
    expect(calls.init).toEqual({ dsn: 'https://key@o1.ingest.sentry.io/2', environment: 'production', release: 'registry/app:v42', tracesSampleRate: 0, sendDefaultPii: false });
    const boom = new Error('boom');
    reportError(boom, { where: 'socket' });
    expect(calls.captured).toEqual([boom]);
  });
});

describe('analytics', () => {
  it('is off without POSTHOG_KEY', async () => {
    const load = vi.fn();
    expect(await createAnalytics({ POSTHOG_KEY: '  ' }, load)).toBe(NO_ANALYTICS);
    expect(load).not.toHaveBeenCalled();
  });

  it('captures server events through posthog-node when POSTHOG_KEY is set', async () => {
    const seen: { key?: string; host?: string; events: unknown[]; shut: boolean } = { events: [], shut: false };
    class FakePostHog {
      constructor(key: string, opts: { host?: string }) {
        seen.key = key;
        seen.host = opts.host;
      }
      capture(m: unknown) {
        seen.events.push(m);
      }
      async shutdown() {
        seen.shut = true;
      }
    }
    const a = await createAnalytics({ POSTHOG_KEY: 'phc_test', POSTHOG_HOST: 'https://eu.i.posthog.com' }, async () => FakePostHog);
    expect(a.enabled).toBe(true);
    a.capture('user-1', 'report_filed', { reason: 'cheating' });
    await a.shutdown();
    expect(seen).toEqual({ key: 'phc_test', host: 'https://eu.i.posthog.com', events: [{ distinctId: 'user-1', event: 'report_filed', properties: { reason: 'cheating', source: 'server' } }], shut: true });
  });
});
