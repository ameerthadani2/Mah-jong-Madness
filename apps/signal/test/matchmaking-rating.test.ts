/**
 * Quick match by rating (src/matchmaking.ts): with more players waiting than one table holds, the
 * closest ratings sit together first; a wide table waits for closer players only until its spread
 * is acceptable, never past the fill time; bots still fill at the fill time; and the separation
 * rules (blocks, one device, one IPv6 /64, the IPv4 preference) still hold. Simulated queues on a
 * fake clock, and a seeded property test over random arrivals that nobody waits longer than the
 * fill wait, as before ratings counted.
 */
import { describe, expect, it } from 'vitest';
import { isIP } from 'node:net';
import { addressKey } from '../src/limits';
import { Matchmaker, ratingSpreadFor, RATING_SPREAD_AT_ONCE, type QueuePeer } from '../src/matchmaking';

const FILL = 20_000;
const TICK = 500;

interface Player {
  id: string;
  rating: number;
  address?: string;
  device?: string;
}

/** A queue with a fake clock, ratings and devices by account; each table is recorded with the time it was opened. */
function queue(players: Player[], opts: { blocks?: Array<[string, string]>; ratingFails?: boolean } = {}) {
  const clock = { now: 5_000_000 };
  const byId = new Map(players.map((p) => [p.id, p]));
  const tables: Array<{ ids: string[]; at: number }> = [];
  const joinedAt = new Map<string, number>();
  const mm = new Matchmaker({
    now: () => clock.now,
    fillMs: FILL,
    check: async () => null,
    avoid: async (id) => (opts.blocks ?? []).flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : [])),
    device: async (peer) => byId.get(peer.userId)?.device ?? null,
    rating: async (id) => {
      if (opts.ratingFails) throw new Error('database down');
      return byId.get(id)!.rating;
    },
    openTable: (ids) => {
      tables.push({ ids, at: clock.now });
      return `ROOM${tables.length}`;
    },
  });
  let n = 0;
  const join = async (id: string) => {
    const p = byId.get(id)!;
    const peer: QueuePeer = { peerId: `p-${++n}`, userId: id, ...(p.address ? { address: p.address } : {}), send: () => undefined };
    joinedAt.set(id, clock.now);
    await mm.enqueue(peer);
  };
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += TICK) {
      clock.now += TICK;
      mm.tick();
    }
  };
  return { mm, clock, tables, join, advance, joinedAt };
}

const p = (id: string, rating: number, extra: Partial<Player> = {}): Player => ({ id, rating, address: `203.0.113.${id.charCodeAt(0) % 250}`, ...extra });

describe('quick match by rating', () => {
  it('with eight players waiting, seats the four close low ratings and the four close high ratings together', async () => {
    // Before ratings counted, the first four to arrive (1200, 2000, 1210, 2010) sat together.
    const players = [p('a', 1200), p('b', 2000), p('c', 1210), p('d', 2010), p('e', 1220), p('f', 2020), p('g', 1230), p('h', 2030)];
    const q = queue(players);
    for (const x of players) await q.join(x.id);
    expect(q.tables.map((t) => t.ids)).toEqual([
      ['a', 'c', 'e', 'g'],
      ['b', 'd', 'f', 'h'],
    ]);
    expect(q.mm.size()).toBe(0);
  });

  it('picks the closest four of six, and the other two wait (bots after the usual wait)', async () => {
    const players = [p('a', 1500), p('b', 1900), p('c', 1510), p('d', 1100), p('e', 1490), p('f', 1505)];
    const q = queue(players);
    for (const x of players) await q.join(x.id);
    expect(q.tables.map((t) => t.ids)).toEqual([['a', 'c', 'e', 'f']]);
    q.advance(FILL - TICK);
    expect(q.tables).toHaveLength(1);
    q.advance(TICK);
    // b's wait is up: seated with d (the only one left) and two bots, at the fill time.
    expect(q.tables.slice(1).map((t) => t.ids)).toEqual([['b', 'd']]);
    expect(q.tables[1].at - q.joinedAt.get('b')!).toBe(FILL);
  });

  it('seats four of the same rating at once, as before (every new account is 1500)', async () => {
    const players = ['a', 'b', 'c', 'd'].map((id) => p(id, 1500));
    const q = queue(players);
    for (const x of players) await q.join(x.id);
    expect(q.tables).toEqual([{ ids: ['a', 'b', 'c', 'd'], at: q.clock.now }]);
  });

  it('a full table of wide ratings waits only until its spread is acceptable, never past the fill time', async () => {
    expect(ratingSpreadFor(0, FILL)).toBe(RATING_SPREAD_AT_ONCE);
    expect(ratingSpreadFor(FILL / 2, FILL)).toBe(600);
    expect(ratingSpreadFor(FILL, FILL)).toBe(Infinity);
    const players = [p('a', 1200), p('b', 1500), p('c', 1700), p('d', 2010)];
    const q = queue(players);
    for (const x of players) await q.join(x.id);
    expect(q.tables).toEqual([]);
    // A spread of 810 is accepted once the first player has waited 15.25 s: the 15.5 s tick.
    q.advance(15_000);
    expect(q.tables).toEqual([]);
    q.advance(TICK);
    expect(q.tables).toEqual([{ ids: ['a', 'b', 'c', 'd'], at: q.joinedAt.get('a')! + 15_500 }]);
  });

  it('a spread too wide to accept before the fill time is seated at the fill time, all four together', async () => {
    const players = [p('a', 400), p('b', 1500), p('c', 2500), p('d', 3500)];
    const q = queue(players);
    for (const x of players) await q.join(x.id);
    q.advance(FILL - TICK);
    expect(q.tables).toEqual([]);
    q.advance(TICK);
    expect(q.tables.map((t) => t.ids)).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('a player whose wait is up is seated with the waiting players closest to its rating', async () => {
    const q = queue([p('a', 1500), p('b', 2400), p('c', 1550), p('d', 3000), p('e', 1450)]);
    await q.join('a');
    q.advance(10_000);
    for (const id of ['b', 'c', 'd', 'e']) await q.join(id);
    q.advance(10_000);
    // a's wait is up: the closest two (c and e) and the next closest (b) sit with it; d waits on.
    expect(q.tables.map((t) => t.ids)).toEqual([['a', 'b', 'c', 'e']]);
    expect(q.mm.waiting()).toEqual(['d']);
  });

  it('reads an unknown rating as 1500', async () => {
    const players = ['a', 'b', 'c', 'd'].map((id, i) => p(id, 1000 + i * 900));
    const q = queue(players, { ratingFails: true });
    for (const x of players) await q.join(x.id);
    expect(q.tables.map((t) => t.ids)).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('never seats the closest ratings together when a block, a device or an IPv6 /64 keeps them apart', async () => {
    const players = [
      p('a', 1500),
      p('b', 1501),
      p('c', 1502, { device: 'dev-1' }),
      p('d', 1503, { device: 'dev-1' }),
      p('e', 1504, { address: '2001:db8:0:1::5' }),
      p('f', 1505, { address: '2001:db8:0:1::6' }),
      p('g', 1700),
      p('h', 1710),
    ];
    const q = queue(players, { blocks: [['a', 'b']] });
    for (const x of players) await q.join(x.id);
    q.advance(FILL);
    for (const t of q.tables) {
      expect(t.ids.includes('a') && t.ids.includes('b')).toBe(false);
      expect(t.ids.includes('c') && t.ids.includes('d')).toBe(false);
      expect(t.ids.includes('e') && t.ids.includes('f')).toBe(false);
    }
    expect(q.mm.size()).toBe(0);
  });

  it('keeps two close ratings from one IPv4 address apart while others are waiting', async () => {
    const players = [p('a', 1500, { address: '198.51.100.7' }), p('b', 1500, { address: '198.51.100.7' }), p('c', 1500), p('d', 1520), p('e', 1540)];
    const q = queue(players);
    for (const x of players) await q.join(x.id);
    expect(q.tables.map((t) => t.ids)).toEqual([['a', 'c', 'd', 'e']]);
    expect(q.mm.waiting()).toEqual(['b']);
  });
});

/** mulberry32: a small seeded generator, so every run sees the same queues. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('a property over random queues', () => {
  it('nobody waits longer than the fill wait, bots fill only after it, and the separation rules always hold', async () => {
    let tablesSeen = 0;
    let fullAtOnce = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const count = 4 + Math.floor(r() * 36);
      const players: Player[] = [];
      for (let i = 0; i < count; i++) {
        const shared = r();
        const address = shared < 0.15 ? '198.51.100.1' : shared < 0.25 ? `2001:db8:0:9::${i}` : `203.0.113.${i}`;
        players.push({ id: `u${i}`, rating: Math.round(800 + r() * 1600), address, ...(r() < 0.1 ? { device: 'shared-device' } : {}) });
      }
      const blocks: Array<[string, string]> = [];
      for (let i = 0; i < count / 5; i++) blocks.push([`u${Math.floor(r() * count)}`, `u${Math.floor(r() * count)}`]);
      const q = queue(players, { blocks });
      // Arrivals spread over 60 s, at any millisecond, with ticks in between as the server runs them.
      const arrivals = players.map((x) => ({ id: x.id, at: Math.floor(r() * 60_000) })).sort((a, b) => a.at - b.at);
      const start = q.clock.now;
      let nextTick = start + TICK;
      for (const a of arrivals) {
        while (nextTick <= start + a.at) {
          q.clock.now = nextTick;
          q.mm.tick();
          nextTick += TICK;
        }
        q.clock.now = start + a.at;
        await q.join(a.id);
      }
      q.clock.now = Math.max(q.clock.now, nextTick - TICK);
      q.advance(FILL + TICK);
      expect(q.mm.size()).toBe(0);

      const byId = new Map(players.map((x) => [x.id, x]));
      const seatedAt = new Map<string, number>();
      for (const t of q.tables) {
        tablesSeen++;
        const earliest = Math.min(...t.ids.map((id) => q.joinedAt.get(id)!));
        if (t.ids.length === 4 && t.at - earliest < FILL) fullAtOnce++;
        // Bots only once the table's first player has waited the fill time.
        if (t.ids.length < 4) expect(t.at - earliest).toBeGreaterThanOrEqual(FILL);
        for (const id of t.ids) seatedAt.set(id, t.at);
        for (let i = 0; i < t.ids.length; i++) {
          for (let j = i + 1; j < t.ids.length; j++) {
            const [x, y] = [byId.get(t.ids[i])!, byId.get(t.ids[j])!];
            expect(blocks.some(([a, b]) => (a === x.id && b === y.id) || (a === y.id && b === x.id))).toBe(false);
            expect(x.device !== undefined && x.device === y.device).toBe(false);
            const [kx, ky] = [addressKey(x.address!), addressKey(y.address!)];
            if (kx === ky) {
              // One IPv6 /64: never. One IPv4 address: only at a table seated because a wait was up.
              expect(isIP(kx)).toBe(4);
              expect(t.at - earliest).toBeGreaterThanOrEqual(FILL);
            }
          }
        }
      }
      // Before ratings counted, every player was seated within the fill wait (on the first tick after it): so now.
      for (const x of players) expect(seatedAt.get(x.id)! - q.joinedAt.get(x.id)!).toBeLessThan(FILL + TICK);
    }
    expect(tablesSeen).toBeGreaterThan(200);
    expect(fullAtOnce).toBeGreaterThan(20);
  });
});
