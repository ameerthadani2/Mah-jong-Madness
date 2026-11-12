/**
 * The player's privacy choices: product analytics and crash reports, each on or off.
 *
 * Rules (tested in consent.test.ts):
 * - Both are opt-in: off until the player says yes. Nothing is captured, queued or sent before that.
 * - The app asks once, after the age gate (`shouldAskConsent`, components/ConsentQuestion.tsx). The answer
 *   sets both switches and is remembered, a "no" included: the question is not asked again.
 * - Either switch can be changed at any time in Settings; a player who set one there before the question
 *   was shown has chosen already and is not asked.
 *
 * Pure TypeScript: storage is an injected key-value store (AsyncStorage in the app, a map in tests).
 * The record lives under its own key, so no other module's storage migration can touch it.
 */

export const CONSENT_KEY = 'mjm.privacy';

export interface ConsentRecord {
  v: 1;
  /** The first-run age gate has been passed (the 'consentGiven' flag). */
  given: boolean;
  /** The age gate found the player under the age of digital consent: analytics default to off. */
  minor: boolean;
  /** Explicit choices; null follows the default. */
  analytics: boolean | null;
  crash: boolean | null;
  /** The one-time question has been answered (yes or no), or a switch was set in Settings: do not ask again. */
  asked: boolean;
}

export const DEFAULT_CONSENT: ConsentRecord = { v: 1, given: false, minor: false, analytics: null, crash: null, asked: false };

export interface EffectiveConsent {
  analytics: boolean;
  crash: boolean;
}

export type ConsentAction = { type: 'given'; minor?: boolean } | { type: 'answer'; agree: boolean; /** The services the question listed (this build's); a yes covers only these. */ about?: { analytics: boolean; crash: boolean } } | { type: 'analytics'; on: boolean } | { type: 'crash'; on: boolean } | { type: 'reset' };

export function consentReducer(s: ConsentRecord, a: ConsentAction): ConsentRecord {
  switch (a.type) {
    case 'given':
      return { ...s, given: true, minor: !!a.minor };
    case 'answer':
      return { ...s, asked: true, analytics: a.agree && (a.about?.analytics ?? true), crash: a.agree && (a.about?.crash ?? true) };
    case 'analytics':
      return { ...s, asked: true, analytics: a.on };
    case 'crash':
      return { ...s, asked: true, crash: a.on };
    case 'reset':
      return DEFAULT_CONSENT;
  }
}

/** Opt-in: a switch the player has not set is off. */
export function effectiveConsent(s: ConsentRecord): EffectiveConsent {
  return { analytics: s.analytics ?? false, crash: s.crash ?? false };
}

/**
 * Whether to show the one-time question now: only in a build that has a service to ask about, only to a player
 * who has neither answered it nor set a switch, and never to one the age gate marked as a minor (theirs stay off).
 */
export function shouldAskConsent(s: ConsentRecord, available: { analytics: boolean; crash: boolean }): boolean {
  if (!available.analytics && !available.crash) return false;
  return !s.asked && !s.minor && s.analytics === null && s.crash === null;
}

const optBool = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);

/** Reads a stored record; anything unreadable starts again from the defaults. */
export function parseConsent(raw: string | null): ConsentRecord {
  if (!raw) return DEFAULT_CONSENT;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.v !== 1) return DEFAULT_CONSENT;
    const analytics = optBool(o.analytics);
    const crash = optBool(o.crash);
    // A record from before the question existed: a switch set in Settings then is a choice made.
    return { v: 1, given: o.given === true, minor: o.minor === true, analytics, crash, asked: o.asked === true || analytics !== null || crash !== null };
  } catch {
    return DEFAULT_CONSENT;
  }
}

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** Holds the record in memory, persists every change and tells listeners. */
export class ConsentStore {
  private record: ConsentRecord = DEFAULT_CONSENT;
  private loading: Promise<ConsentRecord> | null = null;
  private loadedFlag = false;
  private readonly listeners = new Set<(c: EffectiveConsent, r: ConsentRecord) => void>();

  constructor(private readonly kv: KeyValueStore) {}

  get loaded(): boolean {
    return this.loadedFlag;
  }

  get current(): ConsentRecord {
    return this.record;
  }

  get effective(): EffectiveConsent {
    return effectiveConsent(this.record);
  }

  load(): Promise<ConsentRecord> {
    this.loading ??= this.kv
      .getItem(CONSENT_KEY)
      .catch(() => null)
      .then((raw) => {
        // A change made before the stored record arrived is kept: it is the newer choice.
        if (!this.loadedFlag) this.record = parseConsent(raw);
        this.loadedFlag = true;
        this.emit();
        return this.record;
      });
    return this.loading;
  }

  dispatch(a: ConsentAction): ConsentRecord {
    this.record = consentReducer(this.record, a);
    this.loadedFlag = true;
    void this.kv.setItem(CONSENT_KEY, JSON.stringify(this.record)).catch(() => undefined);
    this.emit();
    return this.record;
  }

  subscribe(cb: (c: EffectiveConsent, r: ConsentRecord) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const eff = this.effective;
    for (const l of this.listeners) l(eff, this.record);
  }
}
