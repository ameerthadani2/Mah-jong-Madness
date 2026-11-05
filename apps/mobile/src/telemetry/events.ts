/**
 * The product funnel, as typed events (plan, Phase 6). Pure TypeScript: these builders turn
 * what the app already knows (a screen change, a progress update, a table state) into events,
 * so the wiring in app-state.tsx stays a few lines and every rule here is tested.
 *
 * Properties are small primitives only. Nothing here carries a name, a chat line, a club name or
 * any other text a player typed; club and room codes are left out too.
 */
import type { Progress } from '../storage';

export type MatchMode = 'local' | 'online' | 'club';
export type HandOutcome = 'won' | 'lost' | 'draw';

/** Every event and its properties. Adding an event here is the only way to send one. */
export interface EventProps {
  app_open: { platform: string; build: string; locale: string };
  lesson_complete: { lesson: string };
  puzzle_solved: { kind: 'daily' | 'rush'; correct?: boolean; score?: number };
  match_start: { mode: MatchMode; skill: string };
  hand_over: { mode: MatchMode; hand: number; outcome: HandOutcome };
  shop_view: { from: string };
  purchase_start: { product: string };
  purchase_success: { product: string };
  club_create: Record<string, never>;
  club_join: { status: 'joined' | 'pending' | 'already' };
  audit_failed: { mode: MatchMode; hand: number; failures: number };
  error: { source: 'boot' | 'unhandled' | 'caught'; fatal: boolean; kind: string };
}

export type EventName = keyof EventProps;

export interface TelemetryEvent<E extends EventName = EventName> {
  name: E;
  props: EventProps[E];
}

export const EVENT_NAMES: readonly EventName[] = [
  'app_open',
  'lesson_complete',
  'puzzle_solved',
  'match_start',
  'hand_over',
  'shop_view',
  'purchase_start',
  'purchase_success',
  'club_create',
  'club_join',
  'audit_failed',
  'error',
];

export function event<E extends EventName>(name: E, props: EventProps[E]): TelemetryEvent<E> {
  return { name, props };
}

/** Navigating to a screen that is itself a funnel step. */
export function screenEvents(to: { name: string }, from: { name: string } | undefined): TelemetryEvent[] {
  if (to.name === 'shop' && from?.name !== 'shop') return [event('shop_view', { from: from?.name ?? 'launch' })];
  return [];
}

type ProgressSlice = Pick<Progress, 'lessonsDone' | 'dailySolved' | 'rushRuns' | 'rushBest'>;

/** Funnel steps implied by a progress update: lessons finished, the daily puzzle answered, a rush run ended. */
export function progressEvents(prev: ProgressSlice, next: ProgressSlice): TelemetryEvent[] {
  const out: TelemetryEvent[] = [];
  for (const [id, done] of Object.entries(next.lessonsDone ?? {})) if (done && !prev.lessonsDone?.[id]) out.push(event('lesson_complete', { lesson: id }));
  for (const [day, result] of Object.entries(next.dailySolved ?? {})) if (prev.dailySolved?.[day] === undefined) out.push(event('puzzle_solved', { kind: 'daily', correct: result === 'correct' }));
  if ((next.rushRuns ?? 0) > (prev.rushRuns ?? 0)) out.push(event('puzzle_solved', { kind: 'rush', score: next.rushBest ?? 0 }));
  return out;
}

export function matchMode(session: { mode: 'local' | 'online'; clubCode?: string }): MatchMode {
  return session.mode === 'local' ? 'local' : session.clubCode ? 'club' : 'online';
}

export function matchStartEvent(session: { mode: 'local' | 'online'; clubCode?: string }, skill: string): TelemetryEvent<'match_start'> {
  return event('match_start', { mode: matchMode(session), skill });
}

/** The part of a table client's state the watcher reads (a structural subset of @mjm/net's ClientState). */
export interface TableSnapshot {
  matchId: string | null;
  seat: number | null;
  view: { handNumber: number } | null;
  lastResult: { type: 'win' | 'draw'; wins: Array<{ seat: number }> } | null;
  audits: Array<{ audit: { handNumber: number }; status: string; failures: string[] }>;
}

/** What the watcher remembers between table updates, so each hand and each audit is reported once. */
export interface TableWatch {
  /** `${matchId}:${handNumber}` of the last result reported. */
  lastHand: string | null;
  /** How many audits have been looked at. */
  audits: number;
}

export const EMPTY_TABLE_WATCH: TableWatch = { lastHand: null, audits: 0 };

/**
 * Events from one table update: `hand_over` when a new hand result appears, `audit_failed` for each
 * newly audited hand that failed verification. Returns the watch state to keep for the next update.
 */
export function tableEvents(watch: TableWatch, s: TableSnapshot, mode: MatchMode): { events: TelemetryEvent[]; watch: TableWatch } {
  const events: TelemetryEvent[] = [];
  let lastHand = watch.lastHand;
  if (s.lastResult && s.view) {
    const key = `${s.matchId ?? ''}:${s.view.handNumber}`;
    if (key !== watch.lastHand) {
      lastHand = key;
      const outcome: HandOutcome = s.lastResult.type === 'draw' ? 'draw' : s.lastResult.wins.some((w) => w.seat === s.seat) ? 'won' : 'lost';
      events.push(event('hand_over', { mode, hand: s.view.handNumber, outcome }));
    }
  }
  // A reconnect can hand over a fresh client whose audit list is shorter: count again from there.
  const seen = Math.min(s.audits.length, watch.audits);
  for (const a of s.audits.slice(seen)) if (a.status === 'failed') events.push(event('audit_failed', { mode, hand: a.audit.handNumber, failures: a.failures.length }));
  return { events, watch: { lastHand, audits: s.audits.length } };
}

/** An error as an event: its class name only, never its message (a message can carry user text). */
export function errorEvent(e: unknown, source: EventProps['error']['source'], fatal = false): TelemetryEvent<'error'> {
  const kind = e instanceof Error ? e.name || 'Error' : typeof e;
  return event('error', { source, fatal, kind: kind.slice(0, 40) });
}
