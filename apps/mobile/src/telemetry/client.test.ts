import { describe, expect, it } from 'vitest';
import { Telemetry, type AnalyticsSink, type CrashSink } from './client';
import { ConsentStore, type KeyValueStore } from './consent';

const kv = (raw: string | null): KeyValueStore => ({ getItem: async () => raw, setItem: async () => undefined });
const given = JSON.stringify({ v: 1, given: true });

function fakeSink() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const state = { created: 0, optedOut: 0, optedIn: 0 };
  const sink: AnalyticsSink = { capture: (n, p) => calls.push([n, p]), optIn: () => state.optedIn++, optOut: () => state.optedOut++ };
  return {
    calls,
    state,
    factory: () => {
      state.created++;
      return sink;
    },
  };
}

describe('telemetry client', () => {
  it('is a silent no-op with no keys configured', async () => {
    const consent = new ConsentStore(kv(given));
    await consent.load();
    const tel = new Telemetry({ consent });
    expect(tel.available).toEqual({ analytics: false, crash: false });
    expect(() => tel.track('app_open', { platform: 'web', build: '0', locale: 'en' })).not.toThrow();
    expect(() => tel.captureError(new Error('x'), 'boot')).not.toThrow();
  });

  it('sends nothing before the age gate, then sends once consent is given', async () => {
    const consent = new ConsentStore(kv(null));
    await consent.load();
    const a = fakeSink();
    const tel = new Telemetry({ consent, analytics: a.factory });
    tel.track('shop_view', { from: 'home' });
    expect(a.calls).toEqual([]);
    expect(a.state.created).toBe(0);
    consent.dispatch({ type: 'given' });
    tel.track('shop_view', { from: 'home' });
    expect(a.calls).toEqual([['shop_view', { from: 'home' }]]);
  });

  it('buffers events until the stored consent loads, then sends or drops them', async () => {
    const yes = fakeSink();
    const consentYes = new ConsentStore(kv(given));
    const telYes = new Telemetry({ consent: consentYes, analytics: yes.factory });
    telYes.track('app_open', { platform: 'ios', build: '7', locale: 'zh-TW' });
    expect(yes.calls).toEqual([]);
    await consentYes.load();
    expect(yes.calls.map((c) => c[0])).toEqual(['app_open']);

    const no = fakeSink();
    const consentNo = new ConsentStore(kv(JSON.stringify({ v: 1, given: true, analytics: false })));
    const telNo = new Telemetry({ consent: consentNo, analytics: no.factory });
    telNo.track('app_open', { platform: 'ios', build: '7', locale: 'en' });
    await consentNo.load();
    expect(no.calls).toEqual([]);
  });

  it('opts the analytics service out and back in when the toggle changes', async () => {
    const consent = new ConsentStore(kv(given));
    await consent.load();
    const a = fakeSink();
    const tel = new Telemetry({ consent, analytics: a.factory });
    tel.track('club_create', {});
    consent.dispatch({ type: 'analytics', on: false });
    tel.track('club_create', {});
    expect(a.state.optedOut).toBe(1);
    expect(a.calls).toHaveLength(1);
    consent.dispatch({ type: 'analytics', on: true });
    tel.track('club_join', { status: 'joined' });
    expect(a.state.optedIn).toBe(1);
    expect(a.calls.map((c) => c[0])).toEqual(['club_create', 'club_join']);
    expect(a.state.created).toBe(1);
  });

  it('sends caught errors to crash reports only while they are allowed, and counts them', async () => {
    const consent = new ConsentStore(kv(given));
    await consent.load();
    const captured: unknown[] = [];
    const crash: CrashSink = { capture: (e) => captured.push(e) };
    const a = fakeSink();
    const tel = new Telemetry({ consent, analytics: a.factory, crash });
    const boom = new TypeError('no secure random');
    tel.captureError(boom, 'boot', true);
    expect(captured).toEqual([boom]);
    expect(a.calls).toEqual([['error', { source: 'boot', fatal: true, kind: 'TypeError' }]]);
    consent.dispatch({ type: 'crash', on: false });
    expect(tel.crashAllowed()).toBe(false);
    tel.captureError(boom, 'caught');
    expect(captured).toHaveLength(1);
  });

  it('never lets a failing service break the app', async () => {
    const consent = new ConsentStore(kv(given));
    await consent.load();
    const tel = new Telemetry({
      consent,
      analytics: () => ({ capture: () => { throw new Error('down'); }, optIn: () => undefined, optOut: () => undefined }),
      crash: { capture: () => { throw new Error('down'); } },
    });
    expect(() => tel.track('hand_over', { mode: 'local', hand: 1, outcome: 'won' })).not.toThrow();
    expect(() => tel.captureError(new Error('x'), 'unhandled')).not.toThrow();
    const broken = new Telemetry({ consent, analytics: () => { throw new Error('no native module'); } });
    expect(() => broken.track('club_create', {})).not.toThrow();
  });
});
