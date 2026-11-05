/**
 * Rule and bot labels in the player's language. The engine carries English labels
 * plus `nameZh` / `labelZh` fields; Chinese mahjong terms (底, 台, 一炮多響, 過水 …)
 * stay Chinese in every language. Pure: callers pass `t` and the current locale.
 */
import { BOT_SKILLS, SPEED_PRESETS, type BotSkill, type GameSpeed, type RulePreset, type RuleSet } from '@mjm/engine';
import type { Locale } from '../i18n/resolve';
import { localized, type Translate } from './translate';

export function speedLabel(speed: GameSpeed, locale: Locale): string {
  const p = SPEED_PRESETS[speed];
  return p ? localized(locale, p.label, p.labelZh) : speed;
}

/** Same text as the engine's `describeRules` in English, e.g. "底100 / 台20 · 16 rotations · Normal (15s + 30s bank)". */
export function rulesSummary(r: RuleSet, t: Translate, locale: Locale): string {
  const extras = [r.multipleWinners && '一炮多響', r.passRule && '過水', r.noFlowerTai && '無花1台', !r.allowChi && '不可吃', r.maxTai > 0 && `封頂${r.maxTai}台`].filter(Boolean).join(' · ');
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
