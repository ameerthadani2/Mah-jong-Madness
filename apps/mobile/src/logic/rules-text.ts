/**
 * Rule and bot labels in the player's language. The engine carries English labels
 * plus `nameZh` / `labelZh` fields; Chinese mahjong terms (底, 台, 一炮多響, 過水 …)
 * stay Chinese in every language. Pure: callers pass `t` and the current locale.
 */
import { BOT_SKILLS, ruleExtras, ruleExtraText, SPEED_PRESETS, type BotSkill, type GameSpeed, type RuleExtra, type RulePreset, type RuleSet } from '@mjm/engine';
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
