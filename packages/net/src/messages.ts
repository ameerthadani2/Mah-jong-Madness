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
}

export interface Audit {
  matchId: string;
  handNumber: number;
  seed: string;
  commits: Commitment[];
  reveals: Reveal[];
  log: LoggedAction[];
  finalHash: string;
}

/** Client → host */
export type ClientMessage =
  | { t: 'join'; name: string; avatar?: string; wantSeat?: number; token?: string; userId?: string }
  | { t: 'leave' }
  | { t: 'commit'; hash: string }
  | { t: 'reveal'; secret: string }
  | { t: 'action'; seat: number; action: Action; expectHash?: string }
  | { t: 'ready' }
  | { t: 'chat'; text: string }
  | { t: 'emote'; emote: string }
  | { t: 'ping'; at: number };

/** Host → client */
export type HostMessage =
  | { t: 'welcome'; seat: number; roomCode: string; rules: RuleSet; seats: SeatInfo[]; matchId: string; token: string }
  | { t: 'lobby'; seats: SeatInfo[] }
  | { t: 'commit_request'; handNumber: number }
  | { t: 'commits'; handNumber: number; commits: Commitment[] }
  | { t: 'reveal_request'; handNumber: number }
  | { t: 'state'; view: TableView; hash: string; deadline: number | null; timeBank: number; inTimeBank: boolean }
  | { t: 'hand_over'; result: HandResult; audit: Audit; view: TableView }
  | { t: 'match_over'; scores: number[]; view: TableView }
  | { t: 'error'; code: string; message: string }
  | { t: 'chat'; seat: number; name: string; text: string }
  | { t: 'emote'; seat: number; emote: string }
  | { t: 'pong'; at: number; now: number };

export type Message = ClientMessage | HostMessage;
