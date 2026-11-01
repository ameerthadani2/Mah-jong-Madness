/**
 * Configurable house rules. Defaults follow the most common Taiwanese
 * 16-tile conventions (底 + 台 scoring, 連莊拉莊, flowers, 16-tile dead wall).
 */
export type GameSpeed = 'relaxed' | 'normal' | 'fast' | 'turbo' | 'hyper';

export interface RuleSet {
  /** Base points per transaction (底). */
  basePoints: number;
  /** Points per 台. */
  taiPoints: number;
  /** Cap on 台 per hand (0 = no cap). */
  maxTai: number;
  /** Tiles left undrawn at the end of the wall (流局 threshold). Common: 16. */
  deadWallSize: number;
  /** Dealer bonus 台 when the dealer wins or pays. */
  dealerTai: number;
  /** Extra 台 per consecutive dealer hand (連莊 N → N × this, applied as 連N拉N). */
  dealerStreakTai: number;
  /** A drawn hand keeps the dealer and increments the streak. */
  drawKeepsDealer: boolean;
  /** Allow calling chi (吃) from the left player. */
  allowChi: boolean;
  /** Multiple players may win on the same discard (一炮多響). If false, nearest in turn order wins. */
  multipleWinners: boolean;
  /** 過水: after declining a winnable discard, the player may not win by discard until they draw. */
  passRule: boolean;
  /** Score 無花 (no flowers) as 1 台. Off in most Taiwanese games. */
  noFlowerTai: boolean;
  /** Number of dealer rotations in a match. 16 = one full 將 (4 winds × 4 dealers, excluding 連莊). */
  handsPerMatch: number;
  /** Named speed, for display and presets. `turnSeconds` / `timeBankSeconds` hold the actual values. */
  speed: GameSpeed;
  /** Seconds a player has for each action before their time bank starts. */
  turnSeconds: number;
  /** Extra seconds per hand a player may spend across actions once the turn clock runs out. */
  timeBankSeconds: number;
  /** Points each player starts a match with (for display / club standings). */
  startingPoints: number;
}

export const SPEED_PRESETS: Record<GameSpeed, { turnSeconds: number; timeBankSeconds: number; label: string; labelZh: string }> = {
  relaxed: { turnSeconds: 30, timeBankSeconds: 60, label: 'Relaxed', labelZh: '悠閒' },
  normal: { turnSeconds: 15, timeBankSeconds: 30, label: 'Normal', labelZh: '一般' },
  fast: { turnSeconds: 10, timeBankSeconds: 20, label: 'Fast', labelZh: '快速' },
  turbo: { turnSeconds: 7, timeBankSeconds: 10, label: 'Turbo', labelZh: '極速' },
  hyper: { turnSeconds: 4, timeBankSeconds: 0, label: 'Hyper', labelZh: '閃電' },
};

export const DEFAULT_RULES: RuleSet = {
  basePoints: 100,
  taiPoints: 20,
  maxTai: 0,
  deadWallSize: 16,
  dealerTai: 1,
  dealerStreakTai: 2,
  drawKeepsDealer: true,
  allowChi: true,
  multipleWinners: false,
  passRule: false,
  noFlowerTai: false,
  handsPerMatch: 16,
  speed: 'normal',
  turnSeconds: SPEED_PRESETS.normal.turnSeconds,
  timeBankSeconds: SPEED_PRESETS.normal.timeBankSeconds,
  startingPoints: 0,
};

export function withRules(overrides: Partial<RuleSet> = {}): RuleSet {
  return { ...DEFAULT_RULES, ...overrides };
}

/** Apply a named speed, setting the clock values it implies. */
export function withSpeed(rules: RuleSet, speed: GameSpeed): RuleSet {
  const p = SPEED_PRESETS[speed];
  return { ...rules, speed, turnSeconds: p.turnSeconds, timeBankSeconds: p.timeBankSeconds };
}

export interface RulePreset {
  id: string;
  name: string;
  nameZh: string;
  description: string;
  rules: Partial<RuleSet>;
}

/** Club-ready presets. Point values are abstract chips; clubs decide what a chip is worth off-platform. */
export const RULE_PRESETS: RulePreset[] = [
  { id: 'taiwan-standard', name: 'Taiwan Standard', nameZh: '台灣標準', description: '底100 台20, 16 rotations, normal speed. The default club game.', rules: {} },
  { id: 'small', name: 'Small Stakes', nameZh: '小局', description: '底50 台10. Same rules, gentler swings.', rules: { basePoints: 50, taiPoints: 10 } },
  { id: 'big', name: 'Big Stakes', nameZh: '大局', description: '底300 台100. Every 台 matters.', rules: { basePoints: 300, taiPoints: 100 } },
  { id: 'turbo', name: 'Turbo', nameZh: '極速局', description: '7-second turns with a 10-second bank, 8 rotations. Lunch-break mahjong.', rules: { ...speedFields('turbo'), handsPerMatch: 8 } },
  { id: 'beginner', name: 'Beginner Friendly', nameZh: '新手局', description: 'Relaxed clock, 台 capped at 8, 4 rotations.', rules: { ...speedFields('relaxed'), maxTai: 8, handsPerMatch: 4 } },
  { id: 'purist', name: 'Purist', nameZh: '嚴格局', description: '過水 on, one winner per discard, no flower 台 bonus.', rules: { passRule: true, multipleWinners: false, noFlowerTai: false } },
  { id: 'party', name: 'Party', nameZh: '熱鬧局', description: '一炮多響 on, 無花 1 台, fast speed.', rules: { ...speedFields('fast'), multipleWinners: true, noFlowerTai: true } },
];

function speedFields(speed: GameSpeed): Pick<RuleSet, 'speed' | 'turnSeconds' | 'timeBankSeconds'> {
  const p = SPEED_PRESETS[speed];
  return { speed, turnSeconds: p.turnSeconds, timeBankSeconds: p.timeBankSeconds };
}

export function rulesFromPreset(id: string, base: RuleSet = DEFAULT_RULES): RuleSet {
  const preset = RULE_PRESETS.find((p) => p.id === id);
  return preset ? { ...base, ...preset.rules } : base;
}

/** Human-readable one-liner, e.g. "底100 / 台20 · 16 rotations · Normal (15s + 30s bank)". */
export function describeRules(r: RuleSet): string {
  const speed = SPEED_PRESETS[r.speed]?.label ?? r.speed;
  const extras = [r.multipleWinners && '一炮多響', r.passRule && '過水', r.noFlowerTai && '無花1台', !r.allowChi && '不可吃', r.maxTai > 0 && `封頂${r.maxTai}台`].filter(Boolean).join(' · ');
  return `底${r.basePoints} / 台${r.taiPoints} · ${r.handsPerMatch} rotations · ${speed} (${r.turnSeconds}s + ${r.timeBankSeconds}s bank)${extras ? ' · ' + extras : ''}`;
}
