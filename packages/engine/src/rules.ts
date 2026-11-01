/**
 * Configurable house rules. Defaults follow the most common Taiwanese
 * 16-tile conventions (底 + 台 scoring, 連莊拉莊, flowers, 16-tile dead wall).
 */
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
  /** Number of hands in a match. 16 = one full 將 (4 winds × 4 dealers, before 連莊). */
  handsPerMatch: number;
  /** Seconds a player has to act before the client auto-plays. */
  turnSeconds: number;
}

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
  turnSeconds: 15,
};

export function withRules(overrides: Partial<RuleSet> = {}): RuleSet {
  return { ...DEFAULT_RULES, ...overrides };
}
