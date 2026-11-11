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
  /** 台 for 天胡 (dealer wins on the deal). Charts vary: 24 is the most cited, some tables use 16. 0 for any of the three switches it off: the win is then scored on its own items. */
  heavenlyTai: number;
  /** 台 for 地胡 (non-dealer self-draws on their first draw with no claims yet). */
  earthlyTai: number;
  /** 台 for 人胡 (win on the dealer's first discard). Some tables use 8. */
  humanlyTai: number;
}

/** Inclusive numeric ranges a rule set must stay within; anything outside falls back to the base value. */
export const RULE_LIMITS: Record<Exclude<keyof RuleSet, 'speed' | 'drawKeepsDealer' | 'allowChi' | 'multipleWinners' | 'passRule' | 'noFlowerTai'>, [number, number]> = {
  basePoints: [0, 5000],
  taiPoints: [0, 2000],
  maxTai: [0, 64],
  deadWallSize: [0, 32],
  dealerTai: [0, 8],
  dealerStreakTai: [0, 8],
  handsPerMatch: [1, 64],
  turnSeconds: [3, 120],
  timeBankSeconds: [0, 300],
  startingPoints: [0, 1_000_000],
  heavenlyTai: [0, 64],
  earthlyTai: [0, 64],
  humanlyTai: [0, 64],
};

const BOOLEAN_RULES = ['drawKeepsDealer', 'allowChi', 'multipleWinners', 'passRule', 'noFlowerTai'] as const;

/**
 * Turn untrusted input (a club's saved rules, a create-table request, a host's
 * `welcome`) into a rule set the engine can run safely: unknown keys are dropped,
 * numbers are truncated and clamped to `RULE_LIMITS`, booleans must be real
 * booleans, `speed` must be a known preset, and anything else keeps `base`'s value.
 */
export function sanitizeRules(input: unknown, base: RuleSet = DEFAULT_RULES): RuleSet {
  const out: RuleSet = { ...base };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  for (const key of Object.keys(RULE_LIMITS) as Array<keyof typeof RULE_LIMITS>) {
    const v = src[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const [lo, hi] = RULE_LIMITS[key];
    out[key] = Math.min(hi, Math.max(lo, Math.trunc(v)));
  }
  for (const key of BOOLEAN_RULES) {
    const v = src[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  const speed = src.speed;
  if (typeof speed === 'string' && Object.prototype.hasOwnProperty.call(SPEED_PRESETS, speed)) out.speed = speed as GameSpeed;
  return out;
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
  heavenlyTai: 24,
  earthlyTai: 16,
  humanlyTai: 16,
};

/** Defaults with `overrides` applied, sanitised so the result is always a legal rule set. */
export function withRules(overrides: Partial<RuleSet> = {}): RuleSet {
  return sanitizeRules(overrides, DEFAULT_RULES);
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

/** Club-ready presets. Points are a score, nothing more: they have no monetary value and cannot be redeemed or transferred. */
export const RULE_PRESETS: RulePreset[] = [
  { id: 'taiwan-standard', name: 'Taiwan Standard', nameZh: '台灣標準', description: '底100 台20, 16 rotations, normal speed. The default club game.', rules: {} },
  { id: 'small', name: 'Small Game', nameZh: '小局', description: '底50 台10. Same rules, gentler score swings.', rules: { basePoints: 50, taiPoints: 10 } },
  { id: 'big', name: 'Big Game', nameZh: '大局', description: '底300 台100. Every 台 matters.', rules: { basePoints: 300, taiPoints: 100 } },
  { id: 'turbo', name: 'Turbo', nameZh: '極速局', description: '7-second turns with a 10-second bank, 8 rotations. Lunch-break mahjong.', rules: { ...speedFields('turbo'), handsPerMatch: 8 } },
  { id: 'beginner', name: 'Beginner Friendly', nameZh: '新手局', description: 'Relaxed clock, 台 capped at 8, 4 rotations.', rules: { ...speedFields('relaxed'), maxTai: 8, handsPerMatch: 4 } },
  { id: 'purist', name: 'Purist', nameZh: '嚴格局', description: '過水 on: pass on a winning discard and you must draw before winning again. One winner per discard.', rules: { passRule: true, multipleWinners: false } },
  { id: 'party', name: 'Party', nameZh: '熱鬧局', description: '一炮多響 on, 無花 1 台, fast speed.', rules: { ...speedFields('fast'), multipleWinners: true, noFlowerTai: true } },
];

function speedFields(speed: GameSpeed): Pick<RuleSet, 'speed' | 'turnSeconds' | 'timeBankSeconds'> {
  const p = SPEED_PRESETS[speed];
  return { speed, turnSeconds: p.turnSeconds, timeBankSeconds: p.timeBankSeconds };
}

export function rulesFromPreset(id: string, base: RuleSet = DEFAULT_RULES): RuleSet {
  const preset = RULE_PRESETS.find((p) => p.id === id);
  return preset ? sanitizeRules(preset.rules, sanitizeRules(base)) : sanitizeRules(base);
}

/**
 * The rules that differ from `DEFAULT_RULES` beyond stakes, length and speed, in a fixed order, as
 * data: callers word them (`describeRules` in English, the app in the player's language). Every
 * such rule is listed, so a player joining a table sees exactly what is different about it.
 */
export type RuleExtra =
  | { kind: 'multipleWinners' }
  | { kind: 'passRule' }
  | { kind: 'noFlowerTai' }
  | { kind: 'noChi' }
  | { kind: 'maxTai'; value: number }
  | { kind: 'dealerTai'; value: number }
  | { kind: 'dealerStreakTai'; value: number }
  | { kind: 'drawPassesDeal' }
  | { kind: 'deadWall'; value: number }
  | { kind: 'heavenlyTai'; value: number }
  | { kind: 'earthlyTai'; value: number }
  | { kind: 'humanlyTai'; value: number }
  | { kind: 'startingPoints'; value: number };

export function ruleExtras(r: RuleSet): RuleExtra[] {
  const d = DEFAULT_RULES;
  const out: RuleExtra[] = [];
  if (r.multipleWinners) out.push({ kind: 'multipleWinners' });
  if (r.passRule) out.push({ kind: 'passRule' });
  if (r.noFlowerTai) out.push({ kind: 'noFlowerTai' });
  if (!r.allowChi) out.push({ kind: 'noChi' });
  if (r.maxTai > 0) out.push({ kind: 'maxTai', value: r.maxTai });
  if (r.dealerTai !== d.dealerTai) out.push({ kind: 'dealerTai', value: r.dealerTai });
  if (r.dealerStreakTai !== d.dealerStreakTai) out.push({ kind: 'dealerStreakTai', value: r.dealerStreakTai });
  if (!r.drawKeepsDealer) out.push({ kind: 'drawPassesDeal' });
  if (r.deadWallSize !== d.deadWallSize) out.push({ kind: 'deadWall', value: r.deadWallSize });
  if (r.heavenlyTai !== d.heavenlyTai) out.push({ kind: 'heavenlyTai', value: r.heavenlyTai });
  if (r.earthlyTai !== d.earthlyTai) out.push({ kind: 'earthlyTai', value: r.earthlyTai });
  if (r.humanlyTai !== d.humanlyTai) out.push({ kind: 'humanlyTai', value: r.humanlyTai });
  if (r.startingPoints !== d.startingPoints) out.push({ kind: 'startingPoints', value: r.startingPoints });
  return out;
}

/** One extra in English; Chinese mahjong terms stay Chinese. */
export function ruleExtraText(e: RuleExtra): string {
  switch (e.kind) {
    case 'multipleWinners':
      return '一炮多響';
    case 'passRule':
      return '過水';
    case 'noFlowerTai':
      return '無花1台';
    case 'noChi':
      return '不可吃';
    case 'maxTai':
      return `封頂${e.value}台`;
    case 'dealerTai':
      return `dealer ${e.value}台`;
    case 'dealerStreakTai':
      return `連莊 +${e.value}台 a hand`;
    case 'drawPassesDeal':
      return '流局不連莊';
    case 'deadWall':
      return `dead wall ${e.value}`;
    // 0 switches the limit hand off (the win is scored on its own items), so it is not "0台".
    case 'heavenlyTai':
      return e.value > 0 ? `天胡${e.value}台` : '天胡 off';
    case 'earthlyTai':
      return e.value > 0 ? `地胡${e.value}台` : '地胡 off';
    case 'humanlyTai':
      return e.value > 0 ? `人胡${e.value}台` : '人胡 off';
    case 'startingPoints':
      return `start ${e.value}`;
  }
}

/**
 * Human-readable one-liner, e.g. "底100 / 台20 · 16 rotations · Normal (15s + 30s bank)", followed
 * by every rule that differs from the defaults (see `ruleExtras`).
 */
export function describeRules(r: RuleSet): string {
  const speed = SPEED_PRESETS[r.speed]?.label ?? r.speed;
  const extras = ruleExtras(r).map(ruleExtraText).join(' · ');
  return `底${r.basePoints} / 台${r.taiPoints} · ${r.handsPerMatch} rotations · ${speed} (${r.turnSeconds}s + ${r.timeBankSeconds}s bank)${extras ? ' · ' + extras : ''}`;
}
