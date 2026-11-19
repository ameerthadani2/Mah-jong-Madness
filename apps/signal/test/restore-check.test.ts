/**
 * Restoring a table only from a snapshot the engine accepts (src/restoreCheck.ts, persist.ts,
 * migration 0021): every snapshot an honest table writes passes, in every phase; a snapshot whose
 * game, rules, seats or match position is garbage is never restored as a live table but kept as
 * `damaged`, with the reason, for an admin, on memory and (with DATABASE_URL_TEST) Postgres; a
 * player who comes back to it is told the table is not there; and the admin view lists it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chooseAction, legalActions, randomHex } from '@mjm/engine';
import { TableClient, type HostMessage, type Link, type SerializedHost, type TableHost } from '@mjm/net';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { DAMAGED_KEEP_MS, TablePersister } from '../src/persist';
import { createMemoryRepos, createPgRepos, type TableSnapshotsRepo } from '../src/repos';
import { rulesProblem, snapshotProblem } from '../src/restoreCheck';
import { ROOM_UNAVAILABLE_CODE, RoomRegistry, type Socket } from '../src/rooms';
import { apiFixture } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const ADMIN = 'admin-token-for-tests-0123456789';

type Snap = SerializedHost & Record<string, unknown>;
type Errors = Array<{ code?: string }>;

/** A TableClient seated at a hosted table through the registry, as the socket layer would do it; `errors` collects the registry's error frames. */
function seat(rooms: RoomRegistry, code: string, userId: string, errors: Errors = []) {
  const handlers = new Set<(m: HostMessage) => void>();
  const socket: Socket = {
    send: (j) => {
      const m = JSON.parse(j) as { t: string; code?: string; data?: { ch?: string; msg?: unknown } };
      if (m.t === 'error') errors.push({ code: m.code });
      if (m.t === 'from' && m.data?.ch === 'game') for (const h of handlers) h(m.data.msg as HostMessage);
    },
    close: () => undefined,
  };
  const id = rooms.hello(rooms.connect(socket), userId, undefined, 'Player');
  rooms.handle(id, { t: 'join', room: code });
  const link: Link = {
    send: (msg) => rooms.handle(id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg } }),
    onMessage: (cb) => (handlers.add(cb), () => handlers.delete(cb)),
    close: () => rooms.disconnect(id),
  };
  const client = new TableClient(link, 'Player');
  client.join();
  return client;
}

/** Play a whole match at one human seat (bots answer at once), keeping a JSON copy of the snapshot at every change. */
function playMatch(rules: Record<string, unknown>): Snap[] {
  const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
  const code = rooms.createHostedRoom({ rules });
  const host = rooms.hostedTable(code) as TableHost;
  const snaps: Snap[] = [];
  host.onChange(() => snaps.push(JSON.parse(JSON.stringify(host.serialize())) as Snap));
  const c = seat(rooms, code, 'user-honest');
  host.start();
  for (let guard = 0; guard < 5000 && host.phase !== 'match_over'; guard++) {
    if (host.phase === 'hand_over') c.ready();
    else if (host.phase !== 'playing') break;
    else {
      const s = c.localState();
      if (!s || c.state.seat === null || legalActions(s, c.state.seat).length === 0) break;
      c.act(chooseAction(s, c.state.seat)!);
    }
  }
  rooms.shutdown();
  return snaps;
}

const copy = (s: Snap): Snap => JSON.parse(JSON.stringify(s)) as Snap;

describe('snapshotProblem', () => {
  const snaps = [...playMatch({ handsPerMatch: 2 }), ...playMatch({ handsPerMatch: 2, liguTai: 8, speed: 'fast', turnSeconds: 10, timeBankSeconds: 20, allowChi: false })];
  const playing = snaps.filter((s) => s.phase === 'playing' && Array.isArray(s.game?.actionLog) && s.game.actionLog.length >= 3);
  const between = snaps.filter((s) => (s.phase === 'commit' || s.phase === 'reveal') && s.game !== null);

  it('passes every snapshot an honest table writes, in every phase it can be resumed in', () => {
    const resumable = snaps.filter((s) => s.phase !== 'match_over');
    expect(new Set(resumable.map((s) => s.phase))).toEqual(new Set(['lobby', 'commit', 'reveal', 'playing', 'hand_over']));
    expect(between.length).toBeGreaterThan(0);
    expect(resumable.map(snapshotProblem).filter((p) => p !== null)).toEqual([]);
    // A finished match is not a live table.
    expect(snapshotProblem(snaps.find((s) => s.phase === 'match_over'))).toMatch(/cannot be resumed/);
  });

  it('passes a snapshot written before a rule existed: the missing rule takes its default', () => {
    const old = copy(playing[0]);
    delete (old.rules as unknown as Record<string, unknown>).liguTai;
    delete (old.game!.rules as unknown as Record<string, unknown>).liguTai;
    expect(snapshotProblem(old)).toBeNull();
  });

  it('refuses garbage in the game, the rules, the seats or the match position, saying what is wrong', () => {
    const base = playing[playing.length - 1];
    const after = between[between.length - 1];
    const cases: Array<[string, (s: Snap) => void, RegExp]> = [
      ['game {broken:1}', (s) => void (s.game = { broken: 1 } as never), /no seed or no moves|rules are not a rule set/],
      ['game missing', (s) => void (s.game = null), /hand in play is missing/],
      ["rules 'x'", (s) => void (s.rules = 'x' as never), /rules are not a rule set/],
      ['a rule of the wrong type', (s) => void ((s.rules as unknown as Record<string, unknown>).basePoints = 'abc'), /basePoints/],
      ['a rule out of range', (s) => void ((s.rules as unknown as Record<string, unknown>).turnSeconds = 1000), /turnSeconds/],
      ['the hand dealt under other rules', (s) => void ((s.game!.rules as unknown as Record<string, unknown>).liguTai = 8 - (s.game!.rules.liguTai ?? 0)), /other rules/],
      ['a move taken out', (s) => void s.game!.actionLog.splice(1, 1), /not what its deal and moves give|does not replay/],
      ['a move that is not legal', (s) => void (s.game!.actionLog[s.game!.actionLog.length - 1] = { n: 0, seat: 0, action: { type: 'discard', tile: 999 } } as never), /does not replay/],
      ['a tile moved in the wall', (s) => void s.game!.wall.reverse(), /not what its deal and moves give/],
      ['a score changed', (s) => void (s.game!.scores[0] += 100), /not what its deal and moves give/],
      ['three seats', (s) => void s.seats.pop(), /four seats/],
      ['a time bank that is not a number', (s) => void (s.banks[0] = 'x' as never), /time banks/],
      ['a time bank below nothing', (s) => void (s.banks = s.banks.map(() => -600_000)), /time bank is outside what the rules give/],
      ['a time bank above the whole bank', (s) => void (s.banks[2] = s.rules.timeBankSeconds * 1000 + 1), /time bank is outside what the rules give/],
      ["bot strength 'garbage'", (s) => void (s.botSkill = 'garbage' as never), /bot strength/],
      ['bot strength missing', (s) => void delete (s as Record<string, unknown>).botSkill, /bot strength/],
      ['a player’s seat called a bot', (s) => void (s.seats[0].isBot = true), /seat 0 is called a bot/],
      ['a match position out of range', (s) => void (s.snapshot.dealerSeat = 7), /match position is not valid/],
      ['an unknown version', (s) => void (s.version = 2 as never), /version 2 is unknown/],
      ['a phase that cannot be resumed', (s) => void (s.phase = 'match_over'), /cannot be resumed/],
    ];
    for (const [name, spoil, why] of cases) {
      const s = copy(base);
      spoil(s);
      expect(snapshotProblem(s), name).toMatch(why);
    }
    // Between hands: the last hand must be the one its record published, and the match must follow it.
    const scored = copy(after);
    scored.game!.scores[1] -= 5;
    expect(snapshotProblem(scored)).toMatch(/not the one its record shows/);
    const moved = copy(after);
    moved.snapshot.dealerStreak += 1;
    expect(snapshotProblem(moved)).toMatch(/does not follow the last hand/);
    expect(snapshotProblem({ ...copy(after), game: null })).toMatch(/last hand is missing/);
    expect(snapshotProblem(null)).toMatch(/not an object/);
  });

  it('passes the seat of a player who left as an older build wrote it (a bot named “… (away)”), and banks anywhere from nothing to the whole bank', () => {
    const old = copy(playing[playing.length - 1]);
    old.seats[0].isBot = true;
    old.seats[0].name = `${old.seats[0].name} (away)`;
    old.banks = [0, old.rules.timeBankSeconds * 1000, 1, 0.5];
    expect(snapshotProblem(old)).toBeNull();
  });

  it('checks a rule set as the engine would take it', () => {
    expect(rulesProblem({})).toBeNull();
    expect(rulesProblem({ basePoints: 100, allowChi: false, speed: 'turbo' })).toBeNull();
    expect(rulesProblem([])).toMatch(/not a rule set/);
    expect(rulesProblem({ allowChi: 'yes' })).toMatch(/allowChi/);
    expect(rulesProblem({ speed: 'warp' })).toMatch(/speed/);
    expect(rulesProblem({ handsPerMatch: 2.5 })).toMatch(/handsPerMatch/);
  });
});

/** Three tables mid-hand written by one process; one snapshot's game is set to {broken:1}, another's rules to 'x'. */
async function writeTables(repo: TableSnapshotsRepo) {
  const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
  const persister = new TablePersister(rooms, repo, { log: () => undefined });
  persister.start();
  const codes: string[] = [];
  for (let i = 0; i < 3; i++) {
    const code = rooms.createHostedRoom({ rules: { handsPerMatch: 2 } });
    const c = seat(rooms, code, `user-${i}-${randomHex(3)}`);
    rooms.hostedTable(code)!.start();
    c.act(chooseAction(c.localState()!, 0)!);
    codes.push(code);
  }
  await persister.flush();
  persister.stop();
  rooms.shutdown();
  const [good, badGame, badRules] = codes;
  const g = (await repo.get(badGame))!;
  await repo.save({ ...g, snapshot: { ...(g.snapshot as Snap), game: { broken: 1 } } });
  const r = (await repo.get(badRules))!;
  await repo.save({ ...r, snapshot: { ...(r.snapshot as Snap), rules: 'x' } });
  return { good, badGame, badRules };
}

function restoreContract(name: string, repo: () => TableSnapshotsRepo) {
  describe(name, () => {
    it('restores only the sound table; the damaged ones are kept for an admin with the reason, and the players find them gone', async () => {
      const { good, badGame, badRules } = await writeTables(repo());
      let now = Date.now();
      const lines: string[] = [];
      const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
      const persister = new TablePersister(rooms, repo(), { now: () => now, log: (l) => lines.push(l) });
      expect(await persister.restore()).toEqual([good]);
      expect(persister.damaged).toBe(2);
      expect(rooms.hostedTable(good)?.phase).toBe('playing');
      expect(rooms.hostedTable(badGame)).toBeUndefined();
      expect(rooms.hostedTable(badRules)).toBeUndefined();
      expect(await repo().get(badGame)).toMatchObject({ status: 'damaged', problem: expect.stringMatching(/hand/) });
      expect(await repo().get(badRules)).toMatchObject({ status: 'damaged', problem: 'the rules are not a rule set' });
      // The record is kept as it was found.
      expect(((await repo().get(badGame))!.snapshot as Snap).game).toEqual({ broken: 1 });
      expect(lines.filter((l) => l.includes('kept as damaged for an admin'))).toHaveLength(2);
      expect((await repo().listDamaged(100)).map((s) => s.roomCode).sort()).toEqual([badGame, badRules].sort());
      expect((await repo().listActive()).map((s) => s.roomCode)).toContain(good);
      expect((await repo().listActive()).map((s) => s.roomCode)).not.toContain(badGame);
      // A player coming back to a damaged table is told it is not there, as for any table that ended.
      const errors: Errors = [];
      seat(rooms, badGame, 'user-back', errors);
      expect(errors.map((e) => e.code)).toContain(ROOM_UNAVAILABLE_CODE);
      rooms.shutdown();

      // The next boot does not try them again; 30 days on, the prune drops them.
      const again = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
      const next = new TablePersister(again, repo(), { now: () => now, log: () => undefined });
      expect(await next.restore()).toEqual([good]);
      expect(next.damaged).toBe(0);
      again.shutdown();
      now += DAMAGED_KEEP_MS - 60_000;
      await next.prune();
      expect(await repo().get(badGame)).not.toBeNull();
      now += 120_000;
      expect(await next.prune()).toBeGreaterThanOrEqual(2);
      expect(await repo().get(badGame)).toBeNull();
      expect(await repo().get(badRules)).toBeNull();
    });
  });
}

const memoryRepo = createMemoryRepos().tableSnapshots;
restoreContract('restoring snapshots (memory)', () => memoryRepo);

describe.skipIf(!PG_URL)('restoring snapshots (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pgRepo: TableSnapshotsRepo;
  const schema = 'mjm_restore_' + randomHex(6);
  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => {} });
    pgRepo = createPgRepos(pool).tableSnapshots;
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin?.end();
  });
  restoreContract('contract', () => pgRepo);
});

describe('GET /api/admin/tables/damaged', () => {
  it('lists the damaged tables, the latest first, with the reason and the accounts that were seated; admins only', async () => {
    const f = apiFixture({ deps: { adminToken: ADMIN } });
    const seats = [0, 1, 2, 3].map((i) => ({ seat: i, name: i < 2 ? `P${i}` : `Bot ${i}`, isBot: i >= 2, userId: i < 2 ? `user-${i}` : undefined }));
    await f.repos.tableSnapshots.save({ roomCode: 'DMG001', clubCode: 'CLUB01', status: 'damaged', problem: 'the rules are not a rule set', snapshot: { version: 1, phase: 'playing', seats }, updatedAt: Date.UTC(2026, 10, 18, 1) });
    await f.repos.tableSnapshots.save({ roomCode: 'DMG002', clubCode: null, status: 'damaged', problem: 'the hand in play is missing', snapshot: 'garbage', updatedAt: Date.UTC(2026, 10, 18, 2) });
    await f.repos.tableSnapshots.save({ roomCode: 'LIVE01', clubCode: null, status: 'playing', snapshot: {}, updatedAt: Date.UTC(2026, 10, 18, 3) });
    expect((await f.call('GET', '/api/admin/tables/damaged')).status).toBe(401);
    const res = await f.call('GET', '/api/admin/tables/damaged', undefined, { authorization: `Bearer ${ADMIN}` });
    expect(res.status).toBe(200);
    expect(res.json.tables).toEqual([
      { room: 'DMG002', club: null, problem: 'the hand in play is missing', foundAt: '2026-11-18T02:00:00.000Z', phase: null, accounts: [] },
      { room: 'DMG001', club: 'CLUB01', problem: 'the rules are not a rule set', foundAt: '2026-11-18T01:00:00.000Z', phase: 'playing', accounts: ['user-0', 'user-1'] },
    ]);
  });
});
