/**
 * Soak: several hundred hands at honest tables, played over a simulated network by clients that
 * misbehave the way real phones do. Links carry frames late (up to a few seconds, with stalls),
 * drop at random and at the worst moments (while the deal is being agreed, mid-hand, as a result
 * goes out), stay down for seconds or for several hands, and come back by reconnecting, by an app
 * restart from a record saved a moment earlier, or by an app restart that finds no record at all. Players think, dither into their time bank,
 * or walk away and are timed out. Every device's clock is hours off the server's, drifts, and
 * steps when it reconnects. Some servers crash and restore from a stale snapshot.
 *
 * Through all of it no hand may fail its audit, a hand may be `ok` only when that device watched
 * the deal whole in one attempt over one link, and every device that kept its record ends the
 * match with verified final scores.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules, type RuleSet } from '@mjm/engine';
import { caveatKey, LoopbackHub, TableClient, TableHost, type ClientState, type HostMessage, type Link, type SerializedClient, type SerializedHost } from '../src/index';
import { seededDeals } from './support';

seededDeals(7);

/** Small deterministic generator for the simulation's own choices. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (lo: number, hi: number) => lo + next() * (hi - lo),
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  };
}
type Rng = ReturnType<typeof rng>;

/** Discrete-event clock: everything (network, bots, ticks, players) runs on it. */
class Sim {
  time = 0;
  private seq = 0;
  private heap: Array<{ at: number; seq: number; fn: () => void }> = [];
  at(delay: number, fn: () => void): void {
    this.push({ at: this.time + Math.max(0, delay), seq: this.seq++, fn });
  }
  private push(e: { at: number; seq: number; fn: () => void }): void {
    const h = this.heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p].at < e.at || (h[p].at === e.at && h[p].seq < e.seq)) break;
      h[i] = h[p];
      i = p;
    }
    h[i] = e;
  }
  private pop(): { at: number; seq: number; fn: () => void } | undefined {
    const h = this.heap;
    const top = h[0];
    const last = h.pop();
    if (!top || !last) return top;
    if (h.length > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= h.length) break;
        if (c + 1 < h.length && (h[c + 1].at < h[c].at || (h[c + 1].at === h[c].at && h[c + 1].seq < h[c].seq))) c++;
        if (last.at < h[c].at || (last.at === h[c].at && last.seq < h[c].seq)) break;
        h[i] = h[c];
        i = c;
      }
      h[i] = last;
    }
    return top;
  }
  /** Run events until `done` or the budget runs out; false when it did not finish. */
  run(done: () => boolean, budget: number): boolean {
    let n = 0;
    while (!done()) {
      const e = this.pop();
      if (!e || n++ > budget) return false;
      this.time = e.at;
      e.fn();
    }
    return true;
  }
}

const SPEEDS: Array<Pick<RuleSet, 'turnSeconds' | 'timeBankSeconds'>> = [
  { turnSeconds: 15, timeBankSeconds: 30 },
  { turnSeconds: 15, timeBankSeconds: 30 },
  { turnSeconds: 10, timeBankSeconds: 20 },
  { turnSeconds: 7, timeBankSeconds: 10 },
  { turnSeconds: 4, timeBankSeconds: 0 },
];

interface Problem {
  match: number;
  player: string;
  hand: number;
  what: string;
}

/** One table from the lobby to the end of its match. Returns the hands played and what went wrong. */
function runMatch(index: number, r: Rng, opts: { crash: boolean }): { hands: number; problems: Problem[]; ok: number; partial: number; caveats: Map<string, number>; timeouts: number; drops: number; restores: number; amnesia: number; crashes: number } {
  const sim = new Sim();
  sim.time = 1_700_000_000_000 + index * 86_400_000;
  const problems: Problem[] = [];
  const caveats = new Map<string, number>();
  const stats = { drops: 0, restores: 0, amnesia: 0, crashes: 0 };
  const speed = r.pick(SPEEDS);
  const rules = withRules({ handsPerMatch: r.pick([2, 4, 4, 8]), ...speed });
  const code = `SOAK${index}`;
  let hub = new LoopbackHub();
  let gen = 0;
  const makeHost = (restore?: SerializedHost) => {
    const mine = gen;
    return new TableHost(hub.create('host'), {
      roomCode: code,
      rules,
      matchId: `m-${code}`,
      now: () => sim.time,
      botDelayMs: 600,
      schedule: (fn, ms) => sim.at(ms, () => mine === gen && fn()),
      intermissionSeconds: 8,
      restore,
    });
  };
  let host = makeHost();
  // What the server has on disk: written at once when a hand begins or ends, at most every 2 s in between.
  let disk: string | null = null;
  let diskAt = -Infinity;
  let diskKey = '';
  const persist = () => {
    const boundary = `${host.phase === 'playing' ? 'p' : host.phase}:${host.match().handNumber}`;
    if (boundary === diskKey && sim.time - diskAt < 2_000) return;
    disk = JSON.stringify(host.serialize());
    diskAt = sim.time;
    diskKey = boundary;
  };
  const follow = () => host.onChange(persist);
  follow();

  let wires = 0;
  /** One connection between a player and the table: late, ordered, and mortal. */
  class Wire {
    alive = true;
    readonly id = ++wires;
    private readonly t;
    private readonly base = r.between(40, 900);
    private stalledUntil = 0;
    private lastUp = 0;
    private lastDown = 0;
    private cb: ((m: HostMessage) => void) | null = null;
    private readonly closers = new Set<() => void>();
    readonly link: Link;
    constructor(private readonly p: Player) {
      const myHub = hub;
      this.t = myHub.create(`${p.name}-${this.id}`);
      this.t.onMessage((from, m) => from === 'host' && this.down(m as HostMessage));
      this.link = {
        send: (m) => this.up(m),
        onMessage: (cb) => {
          this.cb = cb;
          return () => {
            if (this.cb === cb) this.cb = null;
          };
        },
        close: () => this.kill(0, 0),
        onClose: (cb) => {
          this.closers.add(cb);
          return () => this.closers.delete(cb);
        },
      };
    }
    private delay(): number {
      // Now and then the link stalls for a few seconds (both ways), then catches up.
      if (sim.time >= this.stalledUntil && r.chance(0.01)) this.stalledUntil = sim.time + r.between(1_500, 7_000);
      return Math.max(this.stalledUntil - sim.time, 0) + this.base * r.between(0.5, 1.8);
    }
    private up(m: unknown): void {
      if (!this.alive) return;
      const at = Math.max(this.lastUp, sim.time + this.delay());
      this.lastUp = at;
      sim.at(at - sim.time, () => this.alive && this.t.send('host', m));
    }
    private down(m: HostMessage): void {
      if (!this.alive) return;
      // Links like to die at the worst moment.
      const worst = m.t === 'commit_request' || m.t === 'reveal_request' ? 0.04 : m.t === 'commits' || m.t === 'hand_over' ? 0.03 : m.t === 'state' && m.view.turnCounter === 0 ? 0.03 : 0;
      if (worst > 0 && r.chance(worst)) {
        const before = r.chance(0.5);
        if (before) return this.p.lose();
        sim.at(this.delay() + r.between(0, 400), () => this.alive && this.p.lose());
      }
      const at = Math.max(this.lastDown, sim.time + this.delay());
      this.lastDown = at;
      sim.at(at - sim.time, () => {
        if (!this.alive || !this.cb) return;
        this.p.saw(m, this);
        this.cb(m);
      });
    }
    /** The link dies now: nothing more arrives either way. Each end notices in its own time. */
    kill(hostNotices: number, clientNotices: number | null): void {
      if (!this.alive) return;
      this.alive = false;
      sim.at(hostNotices, () => this.t.close());
      if (clientNotices !== null) sim.at(clientNotices, () => [...this.closers].forEach((cb) => cb()));
    }
  }

  class Player {
    client!: TableClient;
    wire!: Wire;
    away = false;
    /** The record the app last wrote (400 ms after things went quiet), as an app restart would find it. */
    private saved: string | null = null;
    private saveSeq = 0;
    private readonly skew = r.between(-12, 12) * 3_600_000;
    private readonly drift = r.between(-100, 100) / 1_000_000;
    private step = 0;
    private readonly t0 = sim.time;
    private thinking = '';
    private readonly readied = new Set<number>();
    private seenAudits = 0;
    /** Per hand: the wire on which attempt 1 was requested, or -1 once that deal cannot count as watched whole. */
    private readonly asked = new Map<number, number>();
    readonly watched = new Set<number>();
    timeouts = 0;
    constructor(readonly name: string) {
      this.connect('new');
    }
    private clock = () => Math.round(sim.time + this.skew + (sim.time - this.t0) * this.drift + this.step);
    private connect(how: 'new' | 'rebind' | 'restore' | 'token'): void {
      this.wire = new Wire(this);
      if (how === 'new') this.client = new TableClient(this.wire.link, this.name, undefined, {}, { now: this.clock });
      else if (how === 'token' && this.saved) {
        // The saved record is lost or unreadable: all the app has is its rejoin token.
        stats.amnesia++;
        this.lostRecord = true;
        const token = (JSON.parse(this.saved) as SerializedClient).state.token ?? undefined;
        this.client = new TableClient(this.wire.link, this.name, undefined, { token }, { now: this.clock });
        this.seenAudits = 0;
        this.saved = null;
      } else if (how === 'restore' && this.saved) {
        stats.restores++;
        const saved = JSON.parse(this.saved) as SerializedClient;
        this.client = TableClient.restore(saved, this.wire.link, this.name, undefined, { token: saved.state.token ?? undefined }, { now: this.clock });
        this.seenAudits = Math.min(this.seenAudits, this.client.state.audits.length);
      } else this.client.rebind(this.wire.link);
      if (this.client !== this.heard) {
        this.heard = this.client;
        this.client.onChange((s) => this.changed(s));
      }
      this.away = false;
      this.client.join();
    }
    private heard: TableClient | null = null;
    /** The app came back at least once with nothing but its token: it may hold no hand to check the match's end against. */
    lostRecord = false;
    /** A frame is about to reach the client over `wire`. */
    saw(m: HostMessage, wire: Wire): void {
      if (m.t === 'commit_request') this.asked.set(m.handNumber, m.attempt === 1 && !this.asked.has(m.handNumber) ? wire.id : -1);
      else if (m.t === 'stand_in') this.asked.set(m.handNumber, -1);
      else if (m.t === 'state' && this.asked.get(m.view.handNumber) === wire.id) this.watched.add(m.view.handNumber);
      else if (m.t === 'hand_over' && this.asked.get(m.audit.handNumber) === wire.id) this.watched.add(m.audit.handNumber);
    }
    private changed(s: ClientState): void {
      // The app saves its record 400 ms after the last change.
      const mine = ++this.saveSeq;
      sim.at(400, () => {
        if (mine === this.saveSeq && !this.away) this.saved = JSON.stringify(this.client.serialize());
      });
      for (const a of s.audits.slice(this.seenAudits)) {
        if (a.status === 'failed') problems.push({ match: index, player: this.name, hand: a.audit.handNumber, what: `failed: ${a.failures.join('; ')}` });
        if (a.status === 'partial' && a.caveats.length === 0) problems.push({ match: index, player: this.name, hand: a.audit.handNumber, what: 'partial with no reason given' });
        for (const c of a.caveats) caveats.set(caveatKey(c) ?? c, (caveats.get(caveatKey(c) ?? c) ?? 0) + 1);
      }
      this.seenAudits = s.audits.length;
      if (s.auditStatus === 'failed') problems.push({ match: index, player: this.name, hand: s.lastAudit?.handNumber ?? -1, what: `on show as failed: ${s.auditFailures.join('; ')}` });
      this.act();
    }
    /** What the person holding the phone does next. */
    private act(): void {
      const c = this.client;
      const s = c.state;
      if (this.away || !s.connected || s.disconnected || s.seat === null) return;
      if (s.lastResult !== null && s.lastAudit && !this.readied.has(s.lastAudit.handNumber) && !s.matchOver) {
        this.readied.add(s.lastAudit.handNumber);
        sim.at(r.between(800, 6_000), () => !this.away && this.client.ready());
        return;
      }
      const g = c.localState();
      if (!g || s.lastResult !== null || legalActions(g, s.seat).length === 0) return;
      const key = `${g.handNumber}:${g.turnCounter}`;
      if (this.thinking === key) return;
      this.thinking = key;
      // Mostly quick, sometimes deep into the time bank, and now and then not at all (the table times the seat out).
      const mood = r.next();
      if (mood < 0.04) {
        this.timeouts++;
        return;
      }
      const think = mood < 0.12 ? r.between(rules.turnSeconds * 1000, (rules.turnSeconds + rules.timeBankSeconds) * 1000 + 3_000) : r.between(250, 4_000);
      sim.at(think, () => {
        const now = this.client.localState();
        const seat = this.client.state.seat;
        if (this.away || !now || seat === null || `${now.handNumber}:${now.turnCounter}` !== key || this.client.state.lastResult !== null) return;
        const legal = legalActions(now, seat);
        if (legal.length === 0) return;
        const move = legal.find((a) => a.type === 'hu') ?? (r.chance(0.7) ? chooseAction(now, seat, { seed: key }) : null) ?? r.pick(legal);
        this.client.act(move);
        // An impatient second tap.
        if (r.chance(0.03)) this.client.act(move);
      });
    }
    /** The link is lost. The player is back after a while, on a new link or after an app restart. */
    lose(forMs?: number): void {
      if (this.away) return;
      stats.drops++;
      this.away = true;
      const kind = r.next();
      const gone = forMs ?? (kind < 0.4 ? r.between(300, 6_000) : kind < 0.7 ? r.between(8_000, 70_000) : kind < 0.92 ? r.between(120_000, 480_000) : r.between(600_000, 1_500_000));
      const restart = r.chance(0.3) && this.saved !== null;
      const amnesia = restart && r.chance(0.12);
      // The server may notice at once, or only when its heartbeat gives up (the player may be back first).
      this.wire.kill(r.chance(0.7) ? r.between(0, 1_000) : r.between(1_000, 22_000), restart ? null : r.between(0, 2_500));
      sim.at(gone, () => {
        // A phone that reconnects has often just had its clock corrected.
        this.step += r.chance(0.3) ? r.between(-2_000, 2_000) : 0;
        this.thinking = '';
        this.connect(amnesia && this.saved ? 'token' : restart && this.saved ? 'restore' : 'rebind');
      });
    }
    chaos(): void {
      sim.at(-Math.log(1 - r.next()) * 150_000, () => {
        if (host.phase !== 'match_over') {
          this.lose();
          this.chaos();
        }
      });
    }
    /** Come back now (the match is over and the test wants every device to see its end). */
    ensureBack(): void {
      if (this.away || !this.wire.alive) {
        this.wire.kill(0, 0);
        this.thinking = '';
        this.connect('rebind');
      }
    }
  }

  const humans = r.pick([2, 2, 3, 4]);
  const players = Array.from({ length: humans }, (_, i) => new Player(`P${i}`));
  const tick = () => {
    host.tick();
    sim.at(500, tick);
  };
  sim.at(500, tick);
  // Everyone sits down, then the first to arrive starts the table (bots fill the empty seats).
  if (!sim.run(() => players.every((p) => p.client.state.seat !== null), 100_000)) throw new Error(`match ${index}: players never sat down`);
  host.start();
  for (const p of players) p.chaos();

  if (opts.crash) {
    // One crash somewhere in the match: the process dies, every link with it, and a new process restores the table from disk.
    sim.at(r.between(60_000, 900_000), () => {
      if (host.phase === 'match_over' || host.phase === 'lobby' || !disk) return;
      stats.crashes++;
      const snapshot = disk;
      for (const p of players) {
        p.away = true;
        p.wire.kill(0, r.between(0, 3_000));
      }
      host.close();
      gen++;
      hub = new LoopbackHub();
      host = makeHost(JSON.parse(snapshot) as SerializedHost);
      diskKey = '';
      follow();
      for (const p of players) sim.at(r.between(1_000, 12_000), () => p.ensureBack());
    });
  }

  if (!sim.run(() => host.phase === 'match_over', 6_000_000)) throw new Error(`match ${index}: did not finish (phase ${host.phase}, hand ${host.match().handNumber})`);
  // Everyone comes back to see the end.
  sim.at(30_000, () => players.forEach((p) => p.ensureBack()));
  const end = sim.time + 120_000;
  sim.run(() => sim.time >= end, 2_000_000);

  let ok = 0;
  let partial = 0;
  for (const p of players) {
    const s = p.client.state;
    if (!s.matchOver) problems.push({ match: index, player: p.name, hand: -1, what: `did not see the match end (connected ${s.connected}, error ${String(s.lastError)})` });
    else if (JSON.stringify(s.finalScores) !== JSON.stringify(host.match().scores)) problems.push({ match: index, player: p.name, hand: -1, what: 'final scores differ from the table’s' });
    if (!p.lostRecord && !(p.client.serialize() as unknown as { matchEnded: boolean }).matchEnded) problems.push({ match: index, player: p.name, hand: -1, what: 'the end of the match was not verified from the hands' });
    for (const a of s.audits) {
      if (a.status === 'ok') {
        ok++;
        // Decision: green only for a deal this device watched whole, in one attempt, over one link.
        if (a.audit.ceremonyAttempts !== 1 || !p.watched.has(a.audit.handNumber)) problems.push({ match: index, player: p.name, hand: a.audit.handNumber, what: `ok although the deal was not watched whole in one attempt (attempts ${a.audit.ceremonyAttempts})` });
      } else if (a.status === 'partial') partial++;
      else problems.push({ match: index, player: p.name, hand: a.audit.handNumber, what: `ended ${a.status}: ${a.failures.join('; ')}` });
    }
  }
  host.close();
  return { hands: host.audits.length, problems, ok, partial, caveats, timeouts: players.reduce((n, p) => n + p.timeouts, 0), ...stats };
}

describe('soak: honest tables over a bad network', () => {
  it('300+ hands with drops, rejoins, app restarts, timeouts, late frames, skewed clocks and server crashes: no failed audit, green only for deals watched whole', () => {
    const r = rng(Number(process.env.SOAK_SEED ?? 20261110));
    const total = { hands: 0, ok: 0, partial: 0, timeouts: 0, drops: 0, restores: 0, amnesia: 0, crashes: 0, matches: 0 };
    const caveats = new Map<string, number>();
    const problems: Problem[] = [];
    for (let i = 0; total.hands < 300 && i < 400; i++) {
      const m = runMatch(i, r, { crash: i % 3 === 1 });
      total.matches++;
      for (const k of ['hands', 'ok', 'partial', 'timeouts', 'drops', 'restores', 'amnesia', 'crashes'] as const) total[k] += m[k];
      for (const [k, v] of m.caveats) caveats.set(k, (caveats.get(k) ?? 0) + v);
      problems.push(...m.problems);
    }
    if (process.env.SOAK_REPORT) console.log('SOAK', JSON.stringify(total), JSON.stringify([...caveats]), 'problems', problems.length, JSON.stringify(problems.filter((p) => p.what.startsWith('failed') || !p.what.startsWith('on show')).slice(0, 6)));
    expect(problems.slice(0, 12)).toEqual([]);
    expect(total.hands).toBeGreaterThanOrEqual(300);
    // The run did what it says: plenty of trouble, and plenty of hands still verified outright.
    expect(total.drops).toBeGreaterThan(100);
    expect(total.restores).toBeGreaterThan(10);
    expect(total.amnesia).toBeGreaterThan(3);
    expect(total.timeouts).toBeGreaterThan(50);
    expect(total.crashes).toBeGreaterThan(5);
    expect(total.ok).toBeGreaterThan(total.hands / 2);
    expect(total.partial).toBeGreaterThan(20);
    // The common reasons for an amber hand all came up. (The rarer ones, a seat that joined mid-hand
    // and turns replayed after a crash, come up in most runs but are pinned down in their own tests.)
    for (const k of ['standIn', 'linkLost', 'restarted', 'away', 'gap', 'appRestart']) expect(caveats.get(k) ?? 0, `caveat ${k}`).toBeGreaterThan(0);
  }, 600_000);
});
