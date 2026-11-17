/**
 * The quick-match table rating (src/tableRating.ts, migration 0016): the pairwise Elo update by
 * final scores, the larger K for the first 20 matches, bots and matches with one human left out,
 * one match applied once, the repository on memory and (with DATABASE_URL_TEST) Postgres with a
 * merge, the purge and a restart, and the server moving ratings when a quick-match table finishes.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import type { RoomEvent } from '../src/rooms';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, createRepos, type Repos } from '../src/repos';
import { createSignalServer, type SignalServer } from '../src/server';
import { applyQuickMatchRating, DEFAULT_TABLE_RATING, expectedScore, kFor, PROVISIONAL_K, PROVISIONAL_MATCHES, pairKey, ratingChanges, TABLE_RATING_K, tableRatingView } from '../src/tableRating';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const T0 = Date.UTC(2026, 10, 17, 8, 0, 0);

describe('the rating update', () => {
  it('moves two equal players by K/2 each way, and a draw by nothing', () => {
    const seats = [
      { userId: 'a', rating: 1500, matches: 30, score: 120 },
      { userId: 'b', rating: 1500, matches: 30, score: -120 },
    ];
    expect(ratingChanges(seats)).toEqual([TABLE_RATING_K / 2, -TABLE_RATING_K / 2]);
    expect(ratingChanges(seats.map((s) => ({ ...s, score: 0 })))).toEqual([0, 0]);
  });

  it('scores every pair of humans by final score and averages over the other humans', () => {
    const seats = [
      { userId: 'a', rating: 1500, matches: 50, score: 300 },
      { userId: 'b', rating: 1500, matches: 50, score: 100 },
      { userId: 'c', rating: 1500, matches: 50, score: -100 },
      { userId: 'd', rating: 1500, matches: 50, score: -300 },
    ];
    // First beats three (+1.5 over expectation), second beats two and loses one (+0.5), and so on.
    expect(ratingChanges(seats)).toEqual([8, 3, -3, -8]);
    expect(ratingChanges(seats).reduce((x, y) => x + y, 0)).toBe(0);
  });

  it('expects the stronger player to win, so beating a weaker one gains little and losing to one costs much', () => {
    expect(expectedScore(1700, 1500)).toBeCloseTo(0.76, 2);
    const [strongWins] = ratingChanges([
      { userId: 'a', rating: 1700, matches: 40, score: 1 },
      { userId: 'b', rating: 1500, matches: 40, score: 0 },
    ]);
    const [strongLoses] = ratingChanges([
      { userId: 'a', rating: 1700, matches: 40, score: 0 },
      { userId: 'b', rating: 1500, matches: 40, score: 1 },
    ]);
    expect(strongWins).toBe(4);
    expect(strongLoses).toBe(-12);
  });

  it('uses the larger K for the first 20 matches of an account', () => {
    expect(kFor(0)).toBe(PROVISIONAL_K);
    expect(kFor(PROVISIONAL_MATCHES - 1)).toBe(PROVISIONAL_K);
    expect(kFor(PROVISIONAL_MATCHES)).toBe(TABLE_RATING_K);
    expect(PROVISIONAL_K).toBeGreaterThan(TABLE_RATING_K);
    // The same win: the new account moves by its K, the settled one by its own.
    expect(
      ratingChanges([
        { userId: 'new', rating: 1500, matches: 3, score: 10 },
        { userId: 'old', rating: 1500, matches: 200, score: -10 },
      ]),
    ).toEqual([PROVISIONAL_K / 2, -TABLE_RATING_K / 2]);
  });

  it('keeps a rating within 100 to 4000, and a lone seat never moves', () => {
    expect(ratingChanges([{ userId: 'a', rating: 1500, matches: 0, score: 9 }])).toEqual([0]);
    expect(
      ratingChanges([
        { userId: 'a', rating: 3995, matches: 0, score: 9 },
        { userId: 'b', rating: 3995, matches: 0, score: 0 },
      ])[0],
    ).toBe(5);
  });

  it('scores a seat only against the seats not linked to it, averaged over those', () => {
    const seats = [
      { userId: 'a', rating: 1500, matches: 0, score: 100 },
      { userId: 'b', rating: 1500, matches: 0, score: -100 },
      { userId: 'c', rating: 1500, matches: 0, score: 200 },
    ];
    // Unlinked: a beats b and loses to c (0), b loses to both (-40 * 1 / 2), c beats both.
    expect(ratingChanges(seats)).toEqual([0, -20, 20]);
    // a and b linked: a's win over b does not count, so a is scored against c alone (-20); c against both.
    expect(ratingChanges(seats, new Set([pairKey('b', 'a')]))).toEqual([-20, -20, 20]);
    // Two seats, linked: nobody moves.
    expect(ratingChanges(seats.slice(0, 2), new Set([pairKey('a', 'b')]))).toEqual([0, 0]);
  });

  it('answers 1500, provisional, for an account that has played no rated match', () => {
    expect(tableRatingView(null)).toEqual({ rating: DEFAULT_TABLE_RATING, matches: 0, provisional: true, last: null });
    expect(tableRatingView({ userId: 'a', rating: 1530, matches: 20, lastMatchId: 'm', lastRoom: 'QK7', lastChange: 6, updatedAt: T0 })).toEqual({
      rating: 1530,
      matches: 20,
      provisional: false,
      last: { room: 'QK7', change: 6, at: new Date(T0).toISOString() },
    });
  });
});

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    const user = async (displayName = 'Player') => (await repos().users.create({ id: randomUUID(), kind: 'guest', displayName, createdAt: T0 })).id;
    const seat = (userId: string | undefined, isBot = false) => ({ userId, isBot });

    it('moves the humans of a finished match, never a bot, and applies one match once', async () => {
      const r = repos();
      const [a, b] = [await user('A'), await user('B')];
      const bot = await user('Bot account');
      const match = { matchId: 'm-' + randomHex(6), room: 'QA1', seats: [seat(a), seat(bot, true), seat(b), seat(undefined, true)], scores: [200, 400, -300, -300], players: [a, b] };
      const changes = await applyQuickMatchRating(r, match, T0);
      expect([...changes]).toEqual([
        [a, PROVISIONAL_K / 2],
        [b, -PROVISIONAL_K / 2],
      ]);
      expect(await r.tableRatings.get(a)).toEqual({ userId: a, rating: 1520, matches: 1, lastMatchId: match.matchId, lastRoom: 'QA1', lastChange: 20, updatedAt: T0 });
      expect(await r.tableRatings.get(b)).toMatchObject({ rating: 1480, matches: 1, lastChange: -20 });
      expect(await r.tableRatings.get(bot)).toBeNull();
      // The same match reported again (after a restart, say) changes nothing.
      expect((await applyQuickMatchRating(r, match, T0 + 1000)).size).toBe(0);
      expect((await r.tableRatings.get(a))?.matches).toBe(1);
      expect((await r.tableRatings.getMany([a, b, bot])).map((x) => x.userId).sort()).toEqual([a, b].sort());
    });

    it('never lets a pair that queued from one address or device move each other, while both still count for the rest', async () => {
      const r = repos();
      const [main, alt] = [await user('Main'), await user('Alt')];
      // A second account behind the same home address loses on purpose: the first gains nothing.
      const farm = { matchId: 'farm-' + randomHex(6), room: 'QF1', seats: [seat(main), seat(alt), seat(undefined, true), seat(undefined, true)], scores: [900, -900, 0, 0], players: [main, alt], linked: [[alt, main] as [string, string]] };
      expect((await applyQuickMatchRating(r, farm, T0)).size).toBe(0);
      expect(await r.tableRatings.getMany([main, alt])).toEqual([]);
      // With a stranger at the table, each linked seat is scored against the stranger only.
      const stranger = await user('Stranger');
      const mixed = { matchId: 'mixed-' + randomHex(6), room: 'QF2', seats: [seat(main), seat(alt), seat(stranger), seat(undefined, true)], scores: [900, -900, 0, 0], players: [main, alt, stranger], linked: [[main, alt] as [string, string]] };
      const changes = await applyQuickMatchRating(r, mixed, T0 + 1000);
      expect([...changes]).toEqual([
        [main, PROVISIONAL_K / 2],
        [alt, -PROVISIONAL_K / 2],
        [stranger, 0],
      ]);
      expect(await r.tableRatings.get(main)).toMatchObject({ rating: 1520, matches: 1 });
    });

    it('moves nobody when fewer than two humans played, or for an account the table was not opened for', async () => {
      const r = repos();
      const [a, b, c] = [await user(), await user(), await user()];
      expect((await applyQuickMatchRating(r, { matchId: 'solo-' + randomHex(4), room: 'QB1', seats: [seat(a), seat(undefined, true), seat(undefined, true), seat(undefined, true)], scores: [500, -100, -200, -200] }, T0)).size).toBe(0);
      // b sits in two seats (counted once); c is not among the table's players.
      expect((await applyQuickMatchRating(r, { matchId: 'pair-' + randomHex(4), room: 'QB2', seats: [seat(b), seat(b), seat(c), seat(undefined, true)], scores: [1, 2, 3, 4], players: [a, b] }, T0)).size).toBe(0);
      expect(await r.tableRatings.getMany([a, b, c])).toEqual([]);
    });

    it('keeps the better-supported rating on a merge, and the purge takes it', async () => {
      const r = repos();
      const [guest, account, fresh] = [await user(), await user(), await user()];
      await r.tableRatings.set({ userId: guest, rating: 1620, matches: 30, lastMatchId: 'g', lastRoom: 'QG', lastChange: 4, updatedAt: T0 });
      await r.tableRatings.set({ userId: account, rating: 1450, matches: 12, lastMatchId: 'x', lastRoom: 'QX', lastChange: -6, updatedAt: T0 });
      expect((await r.transaction((tx) => tx.tableRatings.getManyForUpdate([account, guest]))).length).toBe(2);
      await r.tableRatings.mergeInto(guest, account);
      expect(await r.tableRatings.get(account)).toMatchObject({ userId: account, rating: 1620, matches: 30, lastRoom: 'QG' });
      expect(await r.tableRatings.get(guest)).toBeNull();
      await r.tableRatings.set({ userId: fresh, rating: 1900, matches: 2, lastMatchId: null, lastRoom: null, lastChange: 0, updatedAt: T0 });
      await r.tableRatings.mergeInto(fresh, account);
      expect((await r.tableRatings.get(account))?.rating).toBe(1620);
      expect(await r.tableRatings.get(fresh)).toBeNull();
      await r.users.update(account, { deletedAt: T0 });
      expect(await r.users.purgeDeletedIds(T0 + 1)).toContain(account);
      expect(await r.tableRatings.get(account)).toBeNull();
    });
  });
}

let memory: Repos;
beforeAll(() => {
  memory = createMemoryRepos();
});
contract('table ratings (memory)', () => memory);

describe.skipIf(!PG_URL)('table ratings (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_table_ratings_' + randomHex(6);

  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => {} });
    pg = createPgRepos(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin?.end();
  });

  contract('contract', () => pg);

  it('keeps the ratings across a restart (a new pool on the same database)', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    for (const id of [a, b]) await pg.users.create({ id, kind: 'guest', displayName: 'P', createdAt: T0 });
    await applyQuickMatchRating(pg, { matchId: 'restart-1', room: 'QR1', seats: [{ userId: a, isBot: false }, { userId: b, isBot: false }, { isBot: true }, { isBot: true }], scores: [10, -10, 0, 0] }, T0);
    await pool!.end();
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    pg = createPgRepos(pool);
    expect(await pg.tableRatings.get(a)).toMatchObject({ rating: 1520, matches: 1, lastRoom: 'QR1' });
    // Still applied once after the restart.
    expect((await applyQuickMatchRating(pg, { matchId: 'restart-1', room: 'QR1', seats: [{ userId: a, isBot: false }, { userId: b, isBot: false }], scores: [10, -10] }, T0 + 5)).size).toBe(0);
  });
});

describe('the server', () => {
  const servers: SignalServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it('moves the ratings of the humans when a quick-match table finishes, and the API answers them', async () => {
    const repos = createRepos();
    const sessions = new SessionService(repos.repos, { pepper: 'rating-pepper-0123456789abcdef' });
    const server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions, providers: {}, config: loadConfig({}), botDelayMs: 0, persistDebounceMs: 20, log: () => undefined });
    servers.push(server);
    const base = `http://127.0.0.1:${server.address().port}`;
    const guest = async () => (await (await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: { id: randomUUID(), platform: 'ios' }, displayName: 'P' }) })).json()) as { userId: string; session: { token: string } };
    const [a, b] = [await guest(), await guest()];
    const rating = async (token: string, path = '/api/me/table-rating') => ((await (await fetch(base + path, { headers: { authorization: `Bearer ${token}` } })).json()) as { tableRating: unknown }).tableRating;
    expect(await rating(a.session.token)).toEqual({ rating: 1500, matches: 0, provisional: true, last: null });

    const room = server.rooms.createQuickMatchRoom([a.userId, b.userId]);
    const plain = server.rooms.createHostedRoom({});
    // The table reports its end as it does after the last hand (the handlers are the registry's own).
    const emit = (ev: RoomEvent) => (server.rooms as unknown as { eventHandlers: Set<(e: RoomEvent) => void> }).eventHandlers.forEach((h) => h(ev));
    const seats = [
      { seat: 0, name: 'A', peerId: null, isBot: false, connected: true, userId: a.userId },
      { seat: 1, name: 'B', peerId: null, isBot: false, connected: false, userId: b.userId, left: true },
      { seat: 2, name: 'Bot', peerId: null, isBot: true, connected: true },
      { seat: 3, name: 'Bot', peerId: null, isBot: true, connected: true },
    ];
    // A table that is not a quick match moves nothing.
    emit({ room: plain, event: { type: 'match_over', roomCode: plain, matchId: 'plain-1', seats, scores: [100, -100, 0, 0], handNumber: 4, handsWon: [1, 0, 0, 0] } });
    emit({ room, event: { type: 'match_over', roomCode: room, matchId: 'quick-1', seats, scores: [100, -100, 50, -50], handNumber: 4, handsWon: [1, 0, 0, 0] } });
    await expect.poll(() => rating(a.session.token)).toMatchObject({ rating: 1520, matches: 1, last: { room, change: 20 } });
    expect(await rating(b.session.token, '/api/me')).toMatchObject({ rating: 1480, matches: 1, provisional: true, last: { room, change: -20 } });
  });
});
