import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en, zhTW } from '../i18n/locales';
import { CONSENT_KEY, ConsentStore, DEFAULT_CONSENT, consentReducer, effectiveConsent, parseConsent, shouldAskConsent, type KeyValueStore } from './consent';

function memoryKv(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

describe('consent state machine', () => {
  it('is opt-in: both services are off until the player says yes', () => {
    expect(effectiveConsent(DEFAULT_CONSENT)).toEqual({ analytics: false, crash: false });
    // Passing the age gate is not an answer to the question.
    expect(effectiveConsent(consentReducer(DEFAULT_CONSENT, { type: 'given' }))).toEqual({ analytics: false, crash: false });
    expect(effectiveConsent(consentReducer(DEFAULT_CONSENT, { type: 'given', minor: true }))).toEqual({ analytics: false, crash: false });
  });

  it('asks once, after the age gate, in a build that has something to ask about', () => {
    const both = { analytics: true, crash: true };
    const gated = consentReducer(DEFAULT_CONSENT, { type: 'given' });
    expect(shouldAskConsent(gated, both)).toBe(true);
    expect(shouldAskConsent(gated, { analytics: false, crash: true })).toBe(true);
    // No keys in the build (the web preview, a build without the services): nothing to ask.
    expect(shouldAskConsent(gated, { analytics: false, crash: false })).toBe(false);
    // A minor is never asked; both stay off.
    expect(shouldAskConsent(consentReducer(DEFAULT_CONSENT, { type: 'given', minor: true }), both)).toBe(false);
  });

  it('a yes switches both on, a no leaves both off, and either answer is remembered so the question is not asked again', () => {
    const both = { analytics: true, crash: true };
    const gated = consentReducer(DEFAULT_CONSENT, { type: 'given' });
    const yes = consentReducer(gated, { type: 'answer', agree: true });
    expect(effectiveConsent(yes)).toEqual({ analytics: true, crash: true });
    expect(shouldAskConsent(yes, both)).toBe(false);
    const no = consentReducer(gated, { type: 'answer', agree: false });
    expect(effectiveConsent(no)).toEqual({ analytics: false, crash: false });
    expect(shouldAskConsent(no, both)).toBe(false);
    // A yes covers only the services the question listed.
    expect(effectiveConsent(consentReducer(gated, { type: 'answer', agree: true, about: { analytics: false, crash: true } }))).toEqual({ analytics: false, crash: true });
    // The answer survives a restart.
    expect(shouldAskConsent(parseConsent(JSON.stringify(no)), both)).toBe(false);
    expect(effectiveConsent(parseConsent(JSON.stringify(yes)))).toEqual({ analytics: true, crash: true });
    // Passing the age gate again (a new year typed after a reset of the gate) does not ask again or undo the answer.
    expect(shouldAskConsent(consentReducer(no, { type: 'given' }), both)).toBe(false);
    expect(effectiveConsent(consentReducer(yes, { type: 'given' }))).toEqual({ analytics: true, crash: true });
  });

  it('a player who already chose in Settings is not asked, and each switch stays independent', () => {
    const both = { analytics: true, crash: true };
    let s = consentReducer(DEFAULT_CONSENT, { type: 'given' });
    s = consentReducer(s, { type: 'crash', on: true });
    expect(shouldAskConsent(s, both)).toBe(false);
    expect(effectiveConsent(s)).toEqual({ analytics: false, crash: true });
    s = consentReducer(s, { type: 'analytics', on: true });
    s = consentReducer(s, { type: 'crash', on: false });
    expect(effectiveConsent(s)).toEqual({ analytics: true, crash: false });
    // After a yes, a switch turned off in Settings stays off.
    const yes = consentReducer(consentReducer(DEFAULT_CONSENT, { type: 'answer', agree: true }), { type: 'analytics', on: false });
    expect(effectiveConsent(yes)).toEqual({ analytics: false, crash: true });
    expect(consentReducer(s, { type: 'reset' })).toEqual(DEFAULT_CONSENT);
  });

  it('a record stored before the question existed: a switch set then counts as a choice, none set means ask', () => {
    const both = { analytics: true, crash: true };
    // An older install that passed the age gate and never touched Settings had both on by default: now off, and asked once.
    const untouched = parseConsent('{"v":1,"given":true,"minor":false,"analytics":null,"crash":null}');
    expect(effectiveConsent(untouched)).toEqual({ analytics: false, crash: false });
    expect(shouldAskConsent(untouched, both)).toBe(true);
    const choseOff = parseConsent('{"v":1,"given":true,"minor":false,"analytics":false,"crash":null}');
    expect(choseOff.asked).toBe(true);
    expect(shouldAskConsent(choseOff, both)).toBe(false);
  });

  it('reads stored records defensively', () => {
    expect(parseConsent(null)).toEqual(DEFAULT_CONSENT);
    expect(parseConsent('not json')).toEqual(DEFAULT_CONSENT);
    expect(parseConsent('{"v":2,"given":true}')).toEqual(DEFAULT_CONSENT);
    expect(parseConsent('{"v":1,"given":true,"analytics":"yes","crash":false}')).toEqual({ v: 1, given: true, minor: false, analytics: null, crash: false, asked: true });
    expect(parseConsent('{"v":1,"given":true,"asked":"yes"}')).toEqual({ v: 1, given: true, minor: false, analytics: null, crash: null, asked: false });
  });

  it('persists every change under its own key and tells subscribers', async () => {
    const kv = memoryKv({ [CONSENT_KEY]: JSON.stringify({ v: 1, given: true, minor: false, analytics: true, crash: true, asked: true }) });
    const store = new ConsentStore(kv);
    const seen: boolean[] = [];
    store.subscribe((c) => seen.push(c.analytics));
    expect(store.loaded).toBe(false);
    await store.load();
    expect(store.loaded).toBe(true);
    store.dispatch({ type: 'analytics', on: false });
    expect(seen).toEqual([true, false]);
    await Promise.resolve();
    expect(JSON.parse(kv.data[CONSENT_KEY]).analytics).toBe(false);
    // A fresh store (the next launch) sees the saved choice.
    const next = new ConsentStore(kv);
    await next.load();
    expect(next.effective.analytics).toBe(false);
  });

  it('keeps a choice made while the stored record is still loading', async () => {
    let release: (v: string | null) => void = () => undefined;
    const kv: KeyValueStore = { getItem: () => new Promise((r) => (release = r)), setItem: async () => undefined };
    const store = new ConsentStore(kv);
    const loading = store.load();
    store.dispatch({ type: 'crash', on: false });
    release(JSON.stringify({ v: 1, given: false, crash: true }));
    await loading;
    expect(store.effective.crash).toBe(false);
  });

  it('survives a storage that throws', async () => {
    const store = new ConsentStore({ getItem: () => Promise.reject(new Error('blocked')), setItem: () => Promise.reject(new Error('full')) });
    await store.load();
    expect(store.effective).toEqual({ analytics: false, crash: false });
    expect(() => store.dispatch({ type: 'given' })).not.toThrow();
  });
});

describe('the one-time privacy question on screen', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

  it('is shown by Home after the age gate, only when it should be asked', () => {
    const home = read('screens/HomeScreen.tsx');
    const ageGate = home.indexOf("if (gateState === 'ask') return <AgeGate />;");
    const question = home.indexOf("if (gate.status === 'allowed' && shouldAskConsent(consentState.record, telemetryAvailable)) return <ConsentQuestion />;");
    expect(ageGate).toBeGreaterThan(0);
    expect(question).toBeGreaterThan(ageGate);
  });

  it('has a neutral question and two equal buttons, and records the answer either way', () => {
    const q = read('components/ConsentQuestion.tsx');
    const buttons = [...q.matchAll(/<Button testID="consent-(no|yes)" kind="(\w+)" title=\{t\('privacy\.ask\.(no|yes)'\)\} onPress=\{\(\) => answer\((false|true)\)\} style=\{styles\.button\} \/>/g)];
    expect(buttons.map((b) => [b[1], b[2], b[4]])).toEqual([
      ['no', 'secondary', 'false'],
      ['yes', 'secondary', 'true'],
    ]);
    expect(q).toMatch(/button: \{ flex: 1 \}/);
    expect(q).toMatch(/consent\.dispatch\(\{ type: 'answer', agree, about: telemetryAvailable \}\)/);
    // The server is told the same answer, as the Settings switch tells it.
    expect(q).toMatch(/sendAnalyticsConsent\(/);
    for (const locale of [en, zhTW]) {
      expect(locale.privacy.ask.yes.length).toBeGreaterThan(0);
      expect(locale.privacy.ask.no.length).toBeGreaterThan(0);
      // Neither label is dressed up or played down.
      expect(Math.abs([...locale.privacy.ask.yes].length - [...locale.privacy.ask.no].length)).toBeLessThanOrEqual(3);
    }
    expect(en.privacy.ask.body).toMatch(/off unless you say yes/i);
  });

  it('keeps the two switches in Settings, where they still sync the choice to the server', () => {
    const toggles = read('components/PrivacyToggles.tsx');
    expect(toggles).toMatch(/consent\.dispatch\(\{ type: 'analytics', on \}\)/);
    expect(toggles).toMatch(/consent\.dispatch\(\{ type: 'crash', on \}\)/);
    expect(toggles).toMatch(/sendAnalyticsConsent\(/);
    expect(read('screens/SettingsScreen.tsx')).toMatch(/<PrivacyToggles \/>/);
    expect(read('auth/AuthProvider.tsx')).toMatch(/sendAnalyticsConsent\(\{ base, auth: client \}, consent\.effective\.analytics\)/);
  });
});

describe('the crash reporter around the app', () => {
  const native = readFileSync(join(__dirname, 'platform.native.ts'), 'utf8');

  it('wraps the root whenever the build can report crashes, not only when reports had already started at launch', () => {
    expect(native).toMatch(/wrapRoot: \(root\) => \(crashConfigured \? Sentry\.wrap\(root\) : root\)/);
    expect(native).not.toMatch(/wrapRoot: \(root\) => \(sentryStarted/);
    // The flag is set as soon as a DSN is seen, before anything starts.
    expect(native).toMatch(/if \(!dsn\) return null;\n\s+crashConfigured = true;/);
  });

  it('still starts the reporter only from start(), which the client calls once the player has agreed', () => {
    const init = native.indexOf('Sentry.init(');
    const start = native.indexOf('const start = () => {');
    const stop = native.indexOf('const stop = async () => {');
    expect(start).toBeGreaterThan(0);
    expect(init).toBeGreaterThan(start);
    expect(init).toBeLessThan(stop);
    expect(native.match(/Sentry\.init\(/g)).toHaveLength(1);
    expect(native).toMatch(/beforeSend: \(event\) => \(allowed\(\) \? event : null\)/);
  });
});
