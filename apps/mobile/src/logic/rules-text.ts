/**
 * Rule and bot labels in the player's language. The engine carries English labels
 * plus `nameZh` / `labelZh` fields; Chinese mahjong terms (底, 台, 一炮多響, 過水 …)
 * stay Chinese in every language. Pure: callers pass `t` and the current locale.
 */
import {
  BOT_SKILLS,
  RULE_LIMITS,
  RULE_PRESETS,
  ruleExtras,
  ruleExtraText,
  rulesFromPreset,
  sanitizeRules,
  SPEED_PRESETS,
  withSpeed,
  type BotSkill,
  type GameSpeed,
  type RuleExtra,
  type RulePreset,
  type RuleSet,
} from '@mjm/engine';
import type { Locale } from '../i18n/resolve';
import { localized, type Translate } from './translate';

export function speedLabel(speed: GameSpeed, locale: Locale): string {
  const p = SPEED_PRESETS[speed];
  return p ? localized(locale, p.label, p.labelZh) : speed;
}

/**
 * One rule that differs from the defaults, in the player's language. Chinese mahjong terms
 * (一炮多響, 過水, 流局不連莊, 天胡 …) read the same in every language; the rest come from
 * `clubs.rulesText`, whose English matches the engine's `describeRules`.
 */
export function ruleExtraLabel(e: RuleExtra, t: Translate): string {
  switch (e.kind) {
    case 'dealerTai':
      return t('clubs.rulesText.dealerTai', { n: e.value });
    case 'dealerStreakTai':
      return t('clubs.rulesText.dealerStreakTai', { n: e.value });
    case 'deadWall':
      return t('clubs.rulesText.deadWall', { n: e.value });
    case 'startingPoints':
      return t('clubs.rulesText.startingPoints', { n: e.value });
    // 0 switches a limit hand off (the win scores on its own items): say so, never "0台".
    case 'heavenlyTai':
      return e.value > 0 ? ruleExtraText(e) : t('clubs.rulesText.limitOff', { name: '天胡' });
    case 'earthlyTai':
      return e.value > 0 ? ruleExtraText(e) : t('clubs.rulesText.limitOff', { name: '地胡' });
    case 'humanlyTai':
      return e.value > 0 ? ruleExtraText(e) : t('clubs.rulesText.limitOff', { name: '人胡' });
    default:
      return ruleExtraText(e);
  }
}

/**
 * Same text as the engine's `describeRules` in English, e.g. "底100 / 台20 · 16 rotations · Normal
 * (15s + 30s bank)", then every rule that differs from the defaults (dealer and streak 台, dead
 * wall, 流局不連莊, 天/地/人胡 values …), so a joining player sees the whole house.
 */
export function rulesSummary(r: RuleSet, t: Translate, locale: Locale): string {
  const extras = ruleExtras(r)
    .map((e) => ruleExtraLabel(e, t))
    .join(' · ');
  const main = t('common.rules.summary', { base: r.basePoints, tai: r.taiPoints, hands: r.handsPerMatch, speed: speedLabel(r.speed, locale), turn: r.turnSeconds, bank: r.timeBankSeconds });
  return extras ? `${main} · ${extras}` : main;
}

/** Only the stakes ("底100 / 台20"), the same in every language. */
export function rulesStakes(r: RuleSet): string {
  return `底${r.basePoints} / 台${r.taiPoints}`;
}

export function presetName(p: RulePreset, locale: Locale): string {
  return localized(locale, p.name, p.nameZh);
}

/** English comes from the engine; other languages from `settings.presets.<id>`. */
export function presetDescription(p: RulePreset, t: Translate, locale: Locale): string {
  return locale === 'en' ? p.description : t(`settings.presets.${p.id}`);
}

/** Full bot label ("Club player"); `short` drops the trailing " player" as the Home chips do. */
export function botLabel(skill: BotSkill, locale: Locale, short = false): string {
  const b = BOT_SKILLS[skill];
  if (locale === 'zh-TW') return b.labelZh;
  return short ? b.label.replace(' player', '') : b.label;
}

/** English comes from the engine; other languages from `common.bots.<skill>`. */
export function botDescription(skill: BotSkill, t: Translate, locale: Locale): string {
  return locale === 'en' ? BOT_SKILLS[skill].description : t(`common.bots.${skill}`);
}

// ------------------------------------------------------------------ the rule editor's model

export type NumericRule = keyof typeof RULE_LIMITS;
export type BooleanRule = 'drawKeepsDealer' | 'allowChi' | 'multipleWinners' | 'passRule' | 'noFlowerTai';

/** A rule the editor shows: a number within `RULE_LIMITS` (stepped by `step`), an on/off switch, or the speed chips. */
export type RuleField = { key: NumericRule; kind: 'number'; step: number } | { key: BooleanRule; kind: 'toggle' } | { key: 'speed'; kind: 'speed' };

export interface RuleGroup {
  /** Its heading is `clubs.ruleEditor.groups.<id>`; each field's label `clubs.ruleEditor.fields.<key>`. */
  id: 'stakes' | 'length' | 'dealer' | 'wall' | 'claims' | 'flowers' | 'special' | 'speed';
  fields: RuleField[];
}

const num = (key: NumericRule, step = 1): RuleField => ({ key, kind: 'number', step });
const toggle = (key: BooleanRule): RuleField => ({ key, kind: 'toggle' });

/** Every field of a rule set, each exactly once, in the order the editor shows them. */
export const RULE_GROUPS: readonly RuleGroup[] = [
  { id: 'stakes', fields: [num('basePoints', 10), num('taiPoints', 10), num('maxTai')] },
  { id: 'length', fields: [num('handsPerMatch'), num('startingPoints', 100)] },
  { id: 'dealer', fields: [num('dealerTai'), num('dealerStreakTai'), toggle('drawKeepsDealer')] },
  { id: 'wall', fields: [num('deadWallSize', 2)] },
  { id: 'claims', fields: [toggle('passRule'), toggle('multipleWinners'), toggle('allowChi')] },
  { id: 'flowers', fields: [toggle('noFlowerTai')] },
  { id: 'special', fields: [num('heavenlyTai'), num('earthlyTai'), num('humanlyTai')] },
  { id: 'speed', fields: [{ key: 'speed', kind: 'speed' }, num('turnSeconds'), num('timeBankSeconds', 5)] },
];

/** One rule changed, kept within its limits (a number past a limit stops at it). Choosing a speed sets its clocks. */
export function setRule<K extends keyof RuleSet>(r: RuleSet, key: K, value: RuleSet[K]): RuleSet {
  if (key === 'speed') return withSpeed(r, value as GameSpeed);
  if (key in RULE_LIMITS && typeof value === 'number') {
    const [lo, hi] = RULE_LIMITS[key as NumericRule];
    return sanitizeRules({ ...r, [key]: Math.min(hi, Math.max(lo, Math.trunc(value))) }, r);
  }
  return sanitizeRules({ ...r, [key]: value }, r);
}

/** True when two rule sets agree in every field. */
export function sameRules(a: RuleSet, b: RuleSet): boolean {
  return (Object.keys(a) as Array<keyof RuleSet>).every((k) => a[k] === b[k]);
}

/** The preset these rules are exactly, if any. */
export function matchingPreset(r: RuleSet): string | null {
  return RULE_PRESETS.find((p) => sameRules(rulesFromPreset(p.id), r))?.id ?? null;
}

/**
 * Pressing a preset chip. A preset sets a baseline; edits made after it stay until another preset
 * is chosen. With edits on top of the baseline the chip asks first (`confirm`), so nothing is
 * overwritten silently; `force` is the answer to that question.
 */
export function choosePreset(current: RuleSet, baseline: RuleSet, presetId: string, force = false): { action: 'apply'; rules: RuleSet } | { action: 'confirm' } {
  if (!force && !sameRules(current, baseline)) return { action: 'confirm' };
  return { action: 'apply', rules: rulesFromPreset(presetId) };
}
