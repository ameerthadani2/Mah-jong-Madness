import { describe, expect, it } from 'vitest';
import { EMPTY_TABLE_WATCH, EVENT_NAMES, errorEvent, matchStartEvent, progressEvents, screenEvents, tableEvents, type TableSnapshot } from './events';

const progress = (o: Partial<{ lessonsDone: Record<string, boolean>; dailySolved: Record<string, 'correct' | 'wrong'>; rushRuns: number; rushBest: number }> = {}) => ({
  lessonsDone: {},
  dailySolved: {},
  rushRuns: 0,
  rushBest: 0,
  ...o,
});

const table = (o: Partial<TableSnapshot> = {}): TableSnapshot => ({ matchId: 'm1', seat: 0, view: { handNumber: 1 }, lastResult: null, audits: [], ...o });

describe('funnel events', () => {
  it('names exactly the plan’s funnel', () => {
    expect([...EVENT_NAMES].sort()).toEqual(
      ['app_open', 'lesson_complete', 'puzzle_solved', 'match_start', 'hand_over', 'shop_view', 'purchase_start', 'purchase_success', 'club_create', 'club_join', 'audit_failed', 'error'].sort(),
    );
  });

  it('reports a shop visit with where it came from, once per arrival', () => {
    expect(screenEvents({ name: 'shop' }, { name: 'home' })).toEqual([{ name: 'shop_view', props: { from: 'home' } }]);
    expect(screenEvents({ name: 'shop' }, undefined)).toEqual([{ name: 'shop_view', props: { from: 'launch' } }]);
    expect(screenEvents({ name: 'shop' }, { name: 'shop' })).toEqual([]);
    expect(screenEvents({ name: 'learn' }, { name: 'home' })).toEqual([]);
  });

  it('turns progress updates into lesson and puzzle events', () => {
    const prev = progress({ lessonsDone: { a: true }, dailySolved: { '2026-11-04': 'wrong' } });
    const next = progress({ lessonsDone: { a: true, b: true }, dailySolved: { '2026-11-04': 'wrong', '2026-11-05': 'correct' }, rushRuns: 1, rushBest: 14 });
    expect(progressEvents(prev, next)).toEqual([
      { name: 'lesson_complete', props: { lesson: 'b' } },
      { name: 'puzzle_solved', props: { kind: 'daily', correct: true } },
      { name: 'puzzle_solved', props: { kind: 'rush', score: 14 } },
    ]);
    expect(progressEvents(next, next)).toEqual([]);
  });

  it('labels a match by where it is played', () => {
    expect(matchStartEvent({ mode: 'local' }, 'club').props).toEqual({ mode: 'local', skill: 'club' });
    expect(matchStartEvent({ mode: 'online' }, 'pro').props.mode).toBe('online');
    expect(matchStartEvent({ mode: 'online', clubCode: 'ABCDEF' }, 'pro').props.mode).toBe('club');
  });

  it('reports each hand result once, with the player’s outcome', () => {
    const won = table({ lastResult: { type: 'win', wins: [{ seat: 0 }] } });
    const r1 = tableEvents(EMPTY_TABLE_WATCH, won, 'local');
    expect(r1.events).toEqual([{ name: 'hand_over', props: { mode: 'local', hand: 1, outcome: 'won' } }]);
    expect(tableEvents(r1.watch, won, 'local').events).toEqual([]);
    const lost = table({ view: { handNumber: 2 }, lastResult: { type: 'win', wins: [{ seat: 2 }] } });
    expect(tableEvents(r1.watch, lost, 'local').events[0].props).toMatchObject({ hand: 2, outcome: 'lost' });
    const draw = table({ view: { handNumber: 3 }, lastResult: { type: 'draw', wins: [] } });
    expect(tableEvents(r1.watch, draw, 'online').events[0].props).toMatchObject({ outcome: 'draw' });
  });

  it('reports failed audits once and ignores verified ones', () => {
    const audits = [
      { audit: { handNumber: 1 }, status: 'ok', failures: [] },
      { audit: { handNumber: 2 }, status: 'failed', failures: ['bad reveal', 'hash mismatch'] },
    ];
    const r = tableEvents(EMPTY_TABLE_WATCH, table({ audits }), 'club');
    expect(r.events).toEqual([{ name: 'audit_failed', props: { mode: 'club', hand: 2, failures: 2 } }]);
    expect(tableEvents(r.watch, table({ audits }), 'club').events).toEqual([]);
    // A reconnect brings a fresh client with fewer audits: nothing is reported twice.
    expect(tableEvents(r.watch, table({ audits: audits.slice(0, 1) }), 'club').events).toEqual([]);
  });

  it('describes an error by its class only, never its message', () => {
    class SecureRandomError extends Error {
      name = 'SecureRandomError';
    }
    const e = errorEvent(new SecureRandomError('player Alice typed this'), 'boot', true);
    expect(e).toEqual({ name: 'error', props: { source: 'boot', fatal: true, kind: 'SecureRandomError' } });
    expect(JSON.stringify(e)).not.toContain('Alice');
    expect(errorEvent('oops', 'caught').props.kind).toBe('string');
  });
});
