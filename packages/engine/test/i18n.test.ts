import { describe, expect, it } from 'vitest';
import {
  applyAction,
  chooseAction,
  engineReasonTranslations,
  ENGINE_REASON_KEYS,
  fillTemplate,
  formatEngineReason,
  hintFor,
  legalActions,
  matchSnapshot,
  MOVE_GRADE_KEYS,
  newGame,
  reviewHand,
  templateParams,
  type GameState,
  type ReasonParams,
} from '../src/index';

/** Option names i18n-js reads itself; a param with one of these names would change the lookup. */
const I18N_RESERVED = ['scope', 'defaultValue', 'defaults', 'locale', 'missingBehavior'];

interface Produced {
  key: string;
  params: ReasonParams;
  text: string;
  where: string;
}

/** Plays `hands` bot hands, collecting every key the coach and the review produce with its params and English text. */
function collect(hands: number): Produced[] {
  const out: Produced[] = [];
  const skills = ['beginner', 'club', 'pro', 'club'] as const;
  for (let i = 0; i < hands; i++) {
    const start = newGame(`i18n-${i}`);
    // One seat per hand is coached and reviewed, rotating so every seat and dealer position is covered.
    const coached = i % 4;
    let s: GameState = start;
    for (let step = 0; step < 600 && s.phase !== 'ended'; step++) {
      if (legalActions(s, coached).length > 0) {
        const h = hintFor(s, coached);
        out.push({ key: h.statusKey, params: h.statusParams, text: h.status, where: 'status' });
        if (h.discardReason !== undefined) out.push({ key: h.discardReasonKey!, params: h.discardReasonParams!, text: h.discardReason, where: 'discardReason' });
        for (const c of h.claims) {
          out.push({ key: c.labelKey, params: c.labelParams, text: c.label, where: 'claim.label' });
          out.push({ key: c.reasonKey, params: c.reasonParams, text: c.reason, where: 'claim.reason' });
        }
      }
      for (let seat = 0; seat < 4; seat++) {
        const a = chooseAction(s, seat, { seed: `i${seat}`, skill: skills[seat] });
        if (a) {
          s = applyAction(s, seat, a);
          break;
        }
      }
    }
    const end = hintFor(s, coached);
    out.push({ key: end.statusKey, params: end.statusParams, text: end.status, where: 'status' });
    const review = reviewHand(matchSnapshot(start), start.seed, start.rules, s.actionLog, coached);
    out.push({ key: review.summaryKey, params: review.summaryParams, text: review.summary, where: 'summary' });
    for (const m of review.moves) out.push({ key: m.reasonKey, params: m.reasonParams, text: m.explanation, where: 'move' });
  }
  return out;
}

describe('engine reason keys', () => {
  const keys = Object.keys(ENGINE_REASON_KEYS);

  it('every template has both locales, and zh-TW uses the params of the English', () => {
    expect(keys.length).toBeGreaterThan(40);
    // The English names a tile in both scripts (tileName); the Chinese uses the Chinese name alone (tileZh).
    const asChinese = (p: string) => (p === 'tileName' ? 'tileZh' : p);
    for (const key of keys) {
      const tpl = ENGINE_REASON_KEYS[key];
      expect(tpl.en.length, key).toBeGreaterThan(0);
      expect(tpl['zh-TW'].length, key).toBeGreaterThan(0);
      expect(templateParams(tpl['zh-TW']).sort(), key).toEqual(templateParams(tpl.en).map(asChinese).sort());
      for (const p of templateParams(tpl.en)) expect(I18N_RESERVED, `${key} uses %{${p}}`).not.toContain(p);
      // Only a bare placeholder may read the same in both languages.
      if (tpl.en !== '%{action}') expect(tpl['zh-TW'], key).not.toBe(tpl.en);
    }
  });

  it('keys are dotted paths that nest without collisions', () => {
    for (const key of keys) {
      expect(key, key).toMatch(/^(hint|review)\.[a-z]+\.[A-Za-z]+$/);
      // i18n-js stores translations as nested objects: no key may also be the parent of another.
      expect(keys.some((k) => k.startsWith(`${key}.`)), key).toBe(false);
    }
    const nested = engineReasonTranslations('zh-TW') as Record<string, Record<string, Record<string, string>>>;
    expect(nested.hint.discard.efficiency).toBe(ENGINE_REASON_KEYS['hint.discard.efficiency']['zh-TW']);
    expect(nested.review.call.worseShanten).toBe(ENGINE_REASON_KEYS['review.call.worseShanten']['zh-TW']);
  });

  it('every grade has a label key', () => {
    for (const k of Object.values(MOVE_GRADE_KEYS)) expect(ENGINE_REASON_KEYS[k]).toBeDefined();
    expect(formatEngineReason(MOVE_GRADE_KEYS.blunder, {})).toBe('Blunder ??');
  });

  it('fills templates and leaves an unknown placeholder visible', () => {
    expect(fillTemplate('%{a} and %{b}', { a: 1 })).toBe('1 and %{b}');
    expect(formatEngineReason('review.discard.best', { actualName: '北' }, 'zh-TW')).toBe('打 北 是效率最高的選擇。');
    expect(formatEngineReason('no.such.key', {})).toBe('no.such.key');
  });

  it('over 200 bot hands every produced key is registered, its params are supplied, and the English text is the filled template', () => {
    const produced = collect(200);
    const seen = new Set<string>();
    for (const p of produced) {
      const tpl = ENGINE_REASON_KEYS[p.key];
      expect(tpl, `${p.where}: ${p.key}`).toBeDefined();
      seen.add(p.key);
      for (const locale of ['en', 'zh-TW'] as const) {
        for (const name of templateParams(tpl[locale])) expect(p.params, `${p.key} (${locale}) needs %{${name}}`).toHaveProperty(name);
        expect(formatEngineReason(p.key, p.params, locale)).not.toMatch(/%\{/);
      }
      for (const v of Object.values(p.params)) expect(['string', 'number']).toContain(typeof v);
      expect(p.text, p.key).toBe(fillTemplate(tpl.en, p.params));
    }
    // The sample is big enough to reach the common keys of every kind.
    for (const k of ['hint.status.oneAway', 'hint.discard.efficiency', 'hint.claim.noGainConcealed', 'hint.label.pong', 'review.discard.best', 'review.call.passBest', 'review.summary.counts']) {
      expect(seen, k).toContain(k);
    }
    expect(seen.size).toBeGreaterThan(30);
  }, 180_000);
});
