import { describe, expect, it } from 'vitest';
import { Telemetry, type AnalyticsSink, type CrashSink } from './client';
import { ConsentStore, type KeyValueStore } from './consent';

const kv = (raw: string | null): KeyValueStore => ({ getItem: async () => raw, setItem: async () => undefined });
// The stored record of a player who answered yes to the one-time question.
const given = JSON.stringify({ v: 1, given: true, asked: true, analytics: true, crash: true });
// A player who passed the age gate and has not been asked yet, or was asked and said no.
const notAsked = JSON.stringify({ v: 1, given: true });
const declined = JSON.stringify({ v: 1, given: true, asked: true, analytics: false, crash: false });

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

  it('captures nothing until the player agrees: not before the age gate, not after it, not after a no', async () => {
    const consent = new ConsentStore(kv(null));
    await consent.load();
    const a = fakeSink();
    const captured: unknown[] = [];
    const started: string[] = [];
    const tel = new Telemetry({ consent, analytics: a.factory, crash: { capture: (e) => captured.push(e), start: () => started.push('start') } });
    tel.track('shop_view', { from: 'home' });
    tel.captureError(new Error('early'), 'caught');
    // Passing the age gate is not agreement.
    consent.dispatch({ type: 'given' });
    tel.track('shop_view', { from: 'home' });
    tel.captureError(new Error('after the gate'), 'caught');
    expect(a.calls).toEqual([]);
    expect(a.state.created).toBe(0);
    expect(captured).toEqual([]);
    expect(started).toEqual([]);
    expect(tel.crashAllowed()).toBe(false);
    // Yes: from now on, and nothing from before is sent after the fact.
    consent.dispatch({ type: 'answer', agree: true });
    expect(started).toEqual(['start']);
    expect(a.calls).toEqual([]);
    expect(captured).toEqual([]);
    tel.track('shop_view', { from: 'home' });
    expect(a.calls).toEqual([['shop_view', { from: 'home' }]]);

    const no = new ConsentStore(kv(null));
    await no.load();
    const b = fakeSink();
    const telNo = new Telemetry({ consent: no, analytics: b.factory, crash: { capture: (e) => captured.push(e), start: () => started.push('second start') } });
    no.dispatch({ type: 'answer', agree: false });
    telNo.track('shop_view', { from: 'home' });
    telNo.captureError(new Error('declined'), 'caught');
    expect(b.calls).toEqual([]);
    expect(b.state.created).toBe(0);
    expect(started).toEqual(['start']);
  });

  it('drops what was buffered at launch for a player who has not been asked or said no', async () => {
    for (const stored of [null, notAsked, declined]) {
      const consent = new ConsentStore(kv(stored));
      const a = fakeSink();
      const captured: unknown[] = [];
      const tel = new Telemetry({ consent, analytics: a.factory, crash: { capture: (e) => captured.push(e) } });
      tel.track('app_open', { platform: 'ios', build: '1', locale: 'en' });
      tel.captureError(new Error('boot'), 'boot', true);
      await consent.load();
      // Agreeing later does not bring the launch events back.
      consent.dispatch({ type: 'answer', agree: true });
      expect(a.calls, String(stored)).toEqual([]);
      expect(captured, String(stored)).toEqual([]);
    }
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

  it('holds crash reports until the stored consent loads, then sends or drops them', async () => {
    const run = async (stored: string | null) => {
      const consent = new ConsentStore(kv(stored));
      const captured: unknown[] = [];
      const crash: CrashSink = { capture: (e) => captured.push(e) };
      const tel = new Telemetry({ consent, crash });
      const boom = new Error('boot error');
      tel.captureError(boom, 'boot', true);
      // Nothing leaves, and Sentry's own handlers are told no, before the choice is known.
      expect(captured).toEqual([]);
      expect(tel.crashAllowed()).toBe(false);
      await consent.load();
      return captured;
    };
    expect(await run(JSON.stringify({ v: 1, given: true, crash: false }))).toEqual([]);
    expect((await run(given)).map((e) => (e as Error).message)).toEqual(['boot error']);
    // Opt-in: with no stored yes (a new player, or one not asked yet) the boot error is dropped.
    expect(await run(null)).toEqual([]);
    expect(await run(notAsked)).toEqual([]);
  });

  it('starts the crash reporter only once consent allows it, and stops it when the toggle goes off', async () => {
    const log: string[] = [];
    const crash: CrashSink = { capture: () => log.push('capture'), start: () => log.push('start'), stop: () => void log.push('stop') };
    const consentOff = new ConsentStore(kv(JSON.stringify({ v: 1, given: true, crash: false })));
    const off = new Telemetry({ consent: consentOff, crash });
    await consentOff.load();
    expect(log).toEqual([]);
    consentOff.dispatch({ type: 'crash', on: true });
    expect(log).toEqual(['start']);
    off.captureError(new Error('x'), 'caught');
    expect(log).toEqual(['start', 'capture']);
    consentOff.dispatch({ type: 'crash', on: false });
    expect(log).toEqual(['start', 'capture', 'stop']);
    // Unrelated consent changes do not restart it; turning it back on does.
    consentOff.dispatch({ type: 'analytics', on: false });
    expect(log).toEqual(['start', 'capture', 'stop']);
    consentOff.dispatch({ type: 'crash', on: true });
    expect(log).toEqual(['start', 'capture', 'stop', 'start']);

    // Stored consent that allows crash reports starts the reporter as soon as it has loaded, not at construction.
    const log2: string[] = [];
    const consentOn = new ConsentStore(kv(given));
    new Telemetry({ consent: consentOn, crash: { capture: () => undefined, start: () => log2.push('start') } });
    expect(log2).toEqual([]);
    await consentOn.load();
    expect(log2).toEqual(['start']);
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
