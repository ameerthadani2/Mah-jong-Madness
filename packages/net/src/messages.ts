import type { Action, HandResult, LoggedAction, RuleSet, TableView } from '@mjm/engine';
import type { Commitment, Reveal } from './fairness';

export interface SeatInfo {
  seat: number;
  name: string;
  peerId: string | null;
  isBot: boolean;
  connected: boolean;
  avatar?: string;
  /** Stable player id across devices/sessions (client-generated for now). */
  userId?: string;
  /** Remaining time bank in seconds for the current hand. */
  timeBank?: number;
  /** The player left the table on purpose mid-match (a bot plays until they return); not a lost connection. */
  left?: boolean;
}

/** Why a seed ceremony was run again for the same hand. */
export type RestartCause = 'no_reveal' | 'disconnect' | 'host_restarted';

export const RESTART_CAUSES: readonly RestartCause[] = ['no_reveal', 'disconnect', 'host_restarted'];

/** One abandoned ceremony attempt: which attempt failed, the seats it names (0–3, humans only) and why. */
export interface CeremonyRestart {
  attempt: number;
  seats: number[];
  cause: RestartCause;
}

export interface Audit {
  matchId: string;
  handNumber: number;
  seed: string;
  /** Seat 0–3 are players; seat 4 is the host's own committed share. */
  commits: Commitment[];
  reveals: Reveal[];
  log: LoggedAction[];
  finalHash: string;
  /** Seed→wall construction identifier (see engine WALL_RNG_VERSION). */
  rngVersion: string;
  /** How many ceremonies were run for this hand (1 when nothing went wrong). */
  ceremonyAttempts: number;
  /** One entry per abandoned attempt; clients verify these, never the display text. */
  restarts: CeremonyRestart[];
  /** Display text derived from `restarts`. */
  restartReasons: string[];
}

/** Client → host */
export type ClientMessage =
  /**
   * `have`: on a rejoin, the last hand of this match whose end the client holds (-1: none, but it
   * sat at the table from the lobby). The host answers with the audits of the hands after it.
   */
  | { t: 'join'; name: string; avatar?: string; wantSeat?: number; token?: string; userId?: string; have?: number }
  | { t: 'leave' }
  | { t: 'commit'; hash: string }
  | { t: 'reveal'; secret: string }
  /** `turnCounter`: the turn of the view the player acted on (the host echoes it if it refuses the move). */
  | { t: 'action'; seat: number; action: Action; expectHash?: string; turnCounter?: number }
  | { t: 'ready' }
  /** Ask the host to start the match / add a bot (used when the host is a neutral server). */
  | { t: 'start' }
  | { t: 'add_bot' }
  | { t: 'chat'; text: string }
  | { t: 'emote'; emote: string }
  | { t: 'ping'; at: number };

/** Host → client */
export type HostMessage =
  | { t: 'welcome'; seat: number; roomCode: string; rules: RuleSet; seats: SeatInfo[]; matchId: string; token: string }
  | { t: 'lobby'; seats: SeatInfo[] }
  /** `attempt`: which ceremony attempt at this hand (1 for the first). */
  | { t: 'commit_request'; handNumber: number; attempt?: number }
  | { t: 'commits'; handNumber: number; commits: Commitment[] }
  | { t: 'reveal_request'; handNumber: number }
  /** The host used a stand-in secret for this seat (it did not commit in time). */
  | { t: 'stand_in'; handNumber: number; attempt?: number }
  | { t: 'disconnected' }
  /** `now`: the host's clock when it sent the frame (the same clock as `deadline`). */
  | { t: 'state'; view: TableView; hash: string; deadline: number | null; timeBank: number; inTimeBank: boolean; now?: number }
  | { t: 'hand_over'; result: HandResult; audit: Audit; view: TableView; now?: number }
  | { t: 'match_over'; scores: number[]; view: TableView }
  /** To a returning seat: the audit of a hand that ended while it was away (one frame per hand, in order). */
  | { t: 'hand_missed'; audit: Audit }
  /**
   * To a returning seat, while the hand lasts: this table was restored from a saved snapshot (the
   * server restarted). `handNumber` is the hand it resumed and `turnCounter` the turn it resumed
   * at; -1 means before that hand was dealt. Anything the seat was shown beyond that point is void.
   */
  | { t: 'restored'; handNumber: number; turnCounter: number }
  /** `turnCounter`: on a refused action, the turn the player acted on (as it sent it). */
  | { t: 'error'; code: string; message: string; turnCounter?: number }
  | { t: 'chat'; seat: number; name: string; text: string }
  | { t: 'emote'; seat: number; emote: string }
  | { t: 'pong'; at: number; now: number };

export type Message = ClientMessage | HostMessage;
