/**
 * The player's privacy choices: product analytics and crash reports, each on or off.
 *
 * Rules (tested in consent.test.ts):
 * - Analytics stay off until the first-run age gate records consent (`given`), and stay off by
 *   default for a player the gate marks as a minor. After that they default to on.
 * - Crash reports default to on (they carry no gameplay or account data) until switched off.
 * - An explicit choice in Settings always wins over either default.
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
}

export const DEFAULT_CONSENT: ConsentRecord = { v: 1, given: false, minor: false, analytics: null, crash: null };

export interface EffectiveConsent {
  analytics: boolean;
  crash: boolean;
}

export type ConsentAction = { type: 'given'; minor?: boolean } | { type: 'analytics'; on: boolean } | { type: 'crash'; on: boolean } | { type: 'reset' };

export function consentReducer(s: ConsentRecord, a: ConsentAction): ConsentRecord {
  switch (a.type) {
    case 'given':
      return { ...s, given: true, minor: !!a.minor };
    case 'analytics':
      return { ...s, analytics: a.on };
    case 'crash':
      return { ...s, crash: a.on };
    case 'reset':
      return DEFAULT_CONSENT;
  }
}

export function effectiveConsent(s: ConsentRecord): EffectiveConsent {
  return { analytics: s.analytics ?? (s.given && !s.minor), crash: s.crash ?? true };
}

const optBool = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);

/** Reads a stored record; anything unreadable starts again from the defaults. */
export function parseConsent(raw: string | null): ConsentRecord {
  if (!raw) return DEFAULT_CONSENT;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || o.v !== 1) return DEFAULT_CONSENT;
    return { v: 1, given: o.given === true, minor: o.minor === true, analytics: optBool(o.analytics), crash: optBool(o.crash) };
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
