import { describe, expect, it } from 'vitest';
import type { Hint } from '@mjm/engine';
import { coachLines } from './coachText';

/** A translator that shows what it was asked: the key, then the parameters it was given. */
const t = (key: string, params?: Record<string, string | number>) => (params ? `${key} ${JSON.stringify(params)}` : key);

function hint(over: Partial<Hint>): Hint {
  return { seat: 0, phase: 'discard', shanten: 2, status: '', statusKey: 'hint.status.twoAway', statusParams: {}, waits: [], discards: [], claims: [], valueTiles: [], ...over };
}

const claim = (recommended: boolean, labelKey: string) => ({ action: { type: 'pass' as const }, label: '', labelKey, labelParams: { tileName: 'x' }, recommended, reason: '', reasonKey: 'hint.claim.noGain', reasonParams: {} });

describe('what the coach says', () => {
  it('always has a status, in the reader’s language', () => {
    expect(coachLines(hint({}), t).status).toBe('engine.hint.status.twoAway {}');
  });

  it('advises the tile to discard on my turn', () => {
    const lines = coachLines(hint({ discardReasonKey: 'hint.discard.isolated', discardReasonParams: { tileName: '北 (North)' } }), t);
    expect(lines.advice).toBe('engine.hint.discard.isolated {"tileName":"北 (North)"}');
  });

  it('puts a win first, with what it scores', () => {
    const winPreview = { items: [{ nameZh: '自摸', tai: 1 }, { nameZh: '門清', tai: 1 }], tai: 2 } as unknown as Hint['winPreview'];
    const lines = coachLines(hint({ winPreview, discardReasonKey: 'hint.discard.isolated', discardReasonParams: {} }), t);
    expect(lines.advice).toMatch(/^table\.coach\.winPreview /);
    expect(lines.advice).toContain('"tai":2');
    expect(lines.advice).toContain('table.coach.taiItem');
  });

  it('names the claim it recommends, with its reason', () => {
    const lines = coachLines(hint({ phase: 'claim', claims: [claim(false, 'hint.label.chi'), claim(true, 'hint.label.pong')] }), t);
    expect(lines.advice).toMatch(/^table\.coach\.claimLine /);
    expect(lines.advice).toContain('engine.hint.label.pong');
    expect(lines.advice).toContain('engine.hint.claim.noGain');
  });

  it('says Pass at a claim chance it would let go by, with why the claim on offer does not help', () => {
    const lines = coachLines(hint({ phase: 'claim', claims: [claim(false, 'hint.label.pong'), claim(false, 'hint.label.chi')] }), t);
    expect(lines.kind).toBe('pass');
    expect(lines.advice).toMatch(/^table\.coach\.passLine /);
    expect(lines.advice).toContain('engine.hint.claim.noGain');
    // A recommended claim is named instead.
    expect(coachLines(hint({ phase: 'claim', claims: [claim(false, 'hint.label.chi'), claim(true, 'hint.label.pong')] }), t).kind).toBe('claim');
  });

  it('says Pass in both languages', async () => {
    const { en, zhTW } = await import('../../i18n/locales');
    const line = (locale: typeof en) => (locale.table.coach as Record<string, string>).passLine;
    expect(line(en)).toBe('Pass (過): %{reason}');
    expect(line(zhTW)).toBe('過：%{reason}');
  });

  it('has no advice when there is nothing to do now (the hand is over, another seat’s turn)', () => {
    expect(coachLines(hint({ phase: 'ended', statusKey: 'hint.status.handOver' }), t)).toMatchObject({ advice: null, kind: null });
    expect(coachLines(hint({ phase: 'discard', statusKey: 'hint.status.manyAway', statusParams: { shanten: 3 } }), t).advice).toBeNull();
    // No claim on offer (the claim window is another seat's): nothing to pass on.
    expect(coachLines(hint({ phase: 'claim', claims: [] }), t).advice).toBeNull();
  });
});
