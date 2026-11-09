import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import en from '../../i18n/locales/en/table.json';
import zh from '../../i18n/locales/zh-TW/table.json';
import { autoDiscarded, callHaptic, plateScore, resultHaptic } from './feedback';
import { TAP_HINT_DISCARDS, TAP_HINT_KEY, TapHintStore, tapHintVisible, type KeyValueStore } from './tapHint';

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

function memory(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return { data, getItem: async (k) => data[k] ?? null, setItem: async (k, v) => void (data[k] = v) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('haptics', () => {
  it('buzz on the player’s own claims and wins, not on other seats’ calls', () => {
    expect(callHaptic([{ type: 'call', seat: 0, call: 'pong' }], 0)).toBe('claim');
    expect(callHaptic([{ type: 'call', seat: 0, call: 'hu' }], 0)).toBe('win');
    expect(callHaptic([{ type: 'call', seat: 2, call: 'pong' }], 0)).toBeNull();
    expect(callHaptic([{ type: 'discard', seat: 0 }], 0)).toBeNull();
  });

  it('buzz when the player wins or deals in', () => {
    expect(resultHaptic({ type: 'win', wins: [{ seat: 0, selfDrawn: true }] }, 0)).toBe('win');
    expect(resultHaptic({ type: 'win', wins: [{ seat: 2, fromSeat: 0 }] }, 0)).toBe('dealin');
    expect(resultHaptic({ type: 'win', wins: [{ seat: 2, fromSeat: 1 }] }, 0)).toBeNull();
    expect(resultHaptic({ type: 'draw', wins: [] }, 0)).toBeNull();
  });
});

describe('turn timeout', () => {
  it('notices a tile discarded for the player, not one they discarded themselves', () => {
    expect(autoDiscarded({ hand: 1, count: 4 }, { hand: 1, count: 5 }, false)).toBe(true);
    expect(autoDiscarded({ hand: 1, count: 4 }, { hand: 1, count: 5 }, true)).toBe(false);
    expect(autoDiscarded(null, { hand: 1, count: 5 }, false)).toBe(false);
    expect(autoDiscarded({ hand: 1, count: 9 }, { hand: 2, count: 0 }, false)).toBe(false);
  });

  it('says so in both languages and shows the notice at the table', () => {
    expect(en.autoDiscard).toMatch(/%\{tile\}/);
    expect(zh.autoDiscard).toMatch(/%\{tile\}/);
    expect(read('../../screens/TableScreen.tsx')).toMatch(/testID="auto-discard-notice"/);
  });
});

describe('seat plates during the result hold', () => {
  it('keep the score from before the hand until the sheet rolls the change up', () => {
    expect(plateScore(160, 160, true)).toBe(0);
    expect(plateScore(-160, -160, true)).toBe(0);
    expect(plateScore(160, 160, false)).toBe(160);
    expect(plateScore(40, undefined, true)).toBe(40);
  });
});

describe('tap-to-discard hint', () => {
  it('retires after the first few discards and remembers it', async () => {
    const kv = memory();
    const s = new TapHintStore(kv);
    s.subscribe(() => undefined);
    for (let i = 0; i < TAP_HINT_DISCARDS; i++) {
      expect(tapHintVisible(s.get())).toBe(true);
      s.discarded();
    }
    expect(tapHintVisible(s.get())).toBe(false);
    await flush();
    expect(kv.data[TAP_HINT_KEY]).toBe(String(TAP_HINT_DISCARDS));
    // A new launch reads it back.
    const again = new TapHintStore(kv);
    again.subscribe(() => undefined);
    await flush();
    expect(tapHintVisible(again.get())).toBe(false);
  });
});

describe('English gloss on the Chinese table chrome', () => {
  it('glosses the claim buttons, seats and status in English and keeps zh-TW clean', () => {
    expect(en.claimGloss).toMatchObject({ pass: 'Pass', chi: 'Chow', pong: 'Pong', kong: 'Kong', discard: 'Discard', win: 'Win' });
    for (const v of Object.values(zh.claimGloss)) expect(v).toBe('');
    expect(en.status.discarded).toMatch(/discarded/);
    expect(en.relSeat.right).toMatch(/Right/);
    expect(read('./ActionBar.tsx')).toMatch(/gloss=\{t\('table\.claimGloss\.pong'\)\}/);
  });

  it('drops the English 台 names from the zh-TW result sheet', () => {
    expect(read('./ResultSheet.tsx')).toMatch(/locale !== 'zh-TW' && <Text style=\{itemEn\}>/);
  });
});
