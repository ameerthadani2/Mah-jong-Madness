import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '@mjm/engine';
import { createLocalSession } from '../game/session';
import { SAVED_TABLE_MAX_AGE_MS, validActiveSession } from './activeSession';

const NOW = 1_800_000_000_000;

/** A real offline table, saved the way the app saves it, after a trip through JSON like the stored copy. */
async function savedLocal(): Promise<Record<string, unknown>> {
  const session = createLocalSession('Tester', 'auntie', DEFAULT_RULES, { botSkill: 'beginner' });
  session.host!.start();
  for (let i = 0; i < 100 && !session.client.state.view; i++) await new Promise((r) => setTimeout(r, 20));
  const record = { kind: 'local', host: session.host!.serialize(), token: session.client.state.token ?? 'tok', name: 'Tester', avatar: 'auntie', savedAt: NOW };
  session.close();
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

const online = (): Record<string, unknown> => ({ kind: 'online', signalUrl: 'wss://example.test', roomCode: 'AB12', token: 'tok', name: 'Tester', avatar: 'auntie', savedAt: NOW });

describe('the saved-table record read from storage', () => {
  it('accepts a table against bots exactly as the app saved it', async () => {
    const record = await savedLocal();
    expect((record.host as { phase: string }).phase).toBe('playing');
    expect(validActiveSession(record, NOW)).toEqual(record);
  });

  it('accepts online records: plain, club, quick match, and one carrying its verification history', () => {
    expect(validActiveSession(online(), NOW)).toEqual(online());
    const full = { ...online(), clubCode: 'CLUB1', quickMatch: true, client: { version: 1, state: {} } };
    expect(validActiveSession(full, NOW)).toEqual(full);
  });

  it("refuses the assessor's damaged record", () => {
    expect(validActiveSession(JSON.parse('{"kind":"local","state":{"wall":"oops"}}'), NOW)).toBeNull();
    expect(validActiveSession({ kind: 'local', state: { wall: 'oops' }, savedAt: NOW, token: 't', name: 'n', avatar: 'a' }, NOW)).toBeNull();
  });

  it('refuses a table against bots with any field Home or the resume reads missing or of the wrong kind', async () => {
    const good = await savedLocal();
    const host = good.host as Record<string, unknown>;
    const withHost = (change: Record<string, unknown>) => ({ ...good, host: { ...host, ...change } });
    const damaged: unknown[] = [
      { ...good, host: undefined },
      { ...good, token: '' },
      { ...good, name: 7 },
      { ...good, avatar: null },
      { ...good, savedAt: 'yesterday' },
      withHost({ version: 2 }),
      withHost({ snapshot: undefined }),
      withHost({ snapshot: { ...(host.snapshot as object), handNumber: 'one' } }),
      withHost({ snapshot: { ...(host.snapshot as object), scores: [0, 0] } }),
      withHost({ rules: null }),
      withHost({ phase: 'dancing' }),
      withHost({ game: null }),
      withHost({ game: { ...(host.game as object), wall: 'oops' } }),
      withHost({ game: { ...(host.game as object), players: [] } }),
      withHost({ seats: [] }),
      withHost({ banks: 'none' }),
      withHost({ audits: undefined }),
      withHost({ handsWon: 'many' }),
    ];
    for (const record of damaged) expect(validActiveSession(record, NOW), JSON.stringify(record).slice(0, 80)).toBeNull();
  });

  it('refuses damaged online records and anything that is not a record', () => {
    for (const record of [null, 'text', 12, [], {}, { ...online(), kind: 'other' }, { ...online(), signalUrl: '' }, { ...online(), roomCode: 5 }, { ...online(), token: undefined }, { ...online(), clubCode: 9 }, { ...online(), quickMatch: 'yes' }]) {
      expect(validActiveSession(record, NOW)).toBeNull();
    }
  });

  it('keeps an online seat but drops verification history that is not a record', () => {
    expect(validActiveSession({ ...online(), client: 'oops' }, NOW)).toEqual(online());
  });

  it('refuses a record older than twelve hours', () => {
    expect(validActiveSession({ ...online(), savedAt: NOW - SAVED_TABLE_MAX_AGE_MS - 1 }, NOW)).toBeNull();
    expect(validActiveSession({ ...online(), savedAt: NOW - SAVED_TABLE_MAX_AGE_MS + 1000 }, NOW)).not.toBeNull();
  });
});

describe('a saved table whose rules were emptied or damaged', () => {
  it('opens with the rules sanitised, so the wall count is a number and not NaN', async () => {
    const good = await savedLocal();
    const host = good.host as Record<string, unknown>;
    const damaged = { ...good, host: { ...host, rules: {}, game: { ...(host.game as object), rules: { deadWallSize: 'lots' } } } };
    const record = validActiveSession(damaged, NOW);
    expect(record).not.toBeNull();
    const saved = record as unknown as { host: { rules: Record<string, unknown>; game: { rules: Record<string, unknown> } }; token: string };
    expect(saved.host.rules).toEqual(DEFAULT_RULES);
    expect(saved.host.game.rules).toEqual(DEFAULT_RULES);
    const session = createLocalSession('Tester', 'auntie', DEFAULT_RULES, { botSkill: 'beginner', restore: { host: saved.host as never, token: saved.token } });
    for (let i = 0; i < 100 && !session.client.state.view; i++) await new Promise((r) => setTimeout(r, 20));
    const view = session.client.state.view!;
    session.close();
    expect(Number.isFinite(view.drawsLeft)).toBe(true);
    expect(view.drawsLeft).toBeGreaterThan(0);
  });

  it('keeps the table own rules when they are whole, and fills only the damaged ones from the table', async () => {
    const good = await savedLocal();
    const host = good.host as Record<string, unknown>;
    const tableRules = { ...DEFAULT_RULES, basePoints: 300, handsPerMatch: 8 };
    const record = validActiveSession({ ...good, host: { ...host, rules: tableRules, game: { ...(host.game as object), rules: { ...tableRules, taiPoints: null } } } }, NOW) as unknown as { host: { rules: unknown; game: { rules: unknown } } };
    expect(record.host.rules).toEqual(tableRules);
    expect(record.host.game.rules).toEqual(tableRules);
  });
});
