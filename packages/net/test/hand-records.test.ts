/**
 * Records bound to their hand.
 *
 * The phone keeps what it saw of each hand under that hand: the commitments it revealed against, the flags of what the
 * table did wrong, the stretches its ledger vouches for. A frame about another hand neither replaces nor empties what
 * it holds for the hand it is on, and what it saves for an app restart is what it holds in memory: the same records,
 * under the same caps, and never without the hand on show.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import { commitFor, MAX_AUDITS, TableClient, type HostMessage, type Link, type SerializedClient } from '../src/index';
import { makeSecret } from '../src/fairness';
import { keepSeen, MAX_SENT, type CeremonyRecord, type PlayRecord } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
/** The seat's own moves in the hand so far. */
const mineMoves = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;
/** Five well-formed commitments the server makes up. */
const madeUp = () => [0, 1, 2, 3, 4].map((seat) => ({ seat, hash: commitFor(makeSecret()) }));

/**
 * Normal. The phone watches hand 0's deal from its first attempt over one link. When its secret reaches the host, the
 * host swaps its own share (seat 4) for a fresh one and deals from that, so the commitment the audit lists for seat 4
 * is not the one the phone was shown before it revealed. Once the deal has reached the phone, the server cuts the link
 * and, right behind the new welcome, sends: `later`, a well-formed set for hand 1, then hand 0's set with the new seat-4
 * commitment; `standIn`, a stand-in notice for hand 1, then that set; `resend`, that set alone; `plain`, nothing.
 */
function repick(code: string, mode: 'later' | 'standIn' | 'resend' | 'plain') {
  let swapped = false;
  let cut = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    upFilter: (m, w) => {
      if (m.t === 'reveal' && !swapped && w.host.phase === 'reveal' && (w.host as unknown as { snapshot: { handNumber: number } }).snapshot.handNumber === 0) {
        const h = w.host as unknown as { hostSecret: string; hostCommit: string };
        h.hostSecret = makeSecret();
        h.hostCommit = commitFor(h.hostSecret);
        swapped = true;
      }
      return true;
    },
    onTick: (w) => {
      if (!swapped || cut || w.c.state.view?.handNumber !== 0) return;
      cut = true;
      const now = (w.host as unknown as { commits(): Array<{ seat: number; hash: string }> }).commits();
      if (mode === 'later') w.afterWelcome({ t: 'commits', handNumber: 1, commits: madeUp() } as HostMessage);
      if (mode === 'standIn') w.afterWelcome({ t: 'stand_in', handNumber: 1, attempt: 1 } as HostMessage);
      if (mode !== 'plain') w.afterWelcome({ t: 'commits', handNumber: 0, commits: now } as HostMessage);
      w.dropNow();
    },
  });
  w.finish();
  return { w, attacked: swapped && cut };
}

/**
 * Normal. Once the seat has made three moves in hand 0 and owes nothing, the server cuts the link; right behind the new
 * welcome it sends `commits`, a well-formed set for hand 1, or `standIn`, a notice that it made the seat's share for
 * hand 1 (`none`: nothing). Then the table plays hand 0 on, honestly.
 */
function aheadThenOn(code: string, kind: 'commits' | 'standIn' | 'none') {
  let sent = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    onTick: (w) => {
      const g = w.host.game;
      if (sent || !g || w.host.phase !== 'playing' || g.handNumber !== 0 || w.owes() || mineMoves(w) < 3) return;
      sent = true;
      if (kind === 'commits') w.afterWelcome({ t: 'commits', handNumber: 1, commits: madeUp() } as HostMessage);
      if (kind === 'standIn') w.afterWelcome({ t: 'stand_in', handNumber: 1, attempt: 1 } as HostMessage);
      w.dropNow();
    },
  });
  w.finish();
  return { w, sent };
}

describe('the commitments of each hand', () => {
  it('a set for the next hand behind a new welcome, then the hand on show’s set with a share picked after the reveal: red, the set the phone revealed against is kept', () =>
    scenario((i) => {
      const a = repick(`HRL${i}`, 'later');
      need(a.attacked);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['strayFrame', 'commitsChanged', 'commitChangedAfter']));
    }));

  it('a stand-in notice for the next hand behind a new welcome, then that set: red, the set is not emptied', () =>
    scenario((i) => {
      const a = repick(`HRS${i}`, 'standIn');
      need(a.attacked);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['strayFrame', 'commitsChanged', 'commitChangedAfter']));
    }));

  it('a set or stand-in notice for the next hand behind a new welcome, then the hand on show plays on as before: red, a frame about a hand the phone was not on; nothing sent: green', () =>
    scenario((i) => {
      for (const kind of ['commits', 'standIn'] as const) {
        const a = aheadThenOn(`HRA${kind}${i}`, kind);
        need(a.sent);
        expect(a.w.verdict().status, kind).toBe('failed');
        expect(a.w.verdict().failures, kind).toEqual(['strayFrame']);
      }
      const b = aheadThenOn(`HRAcommits${i}`, 'none');
      need(b.sent);
      expect(b.w.verdict()).toMatchObject({ status: 'ok', failures: [] });
    }));

  it('the same set sent again alone, or nothing sent: red as before', () =>
    scenario((i) => {
      const a = repick(`HRR${i}`, 'resend');
      need(a.attacked);
      expect(a.w.verdict()).toMatchObject({ status: 'failed' });
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['commitsChanged', 'commitChangedAfter']));
      const b = repick(`HRP${i}`, 'plain');
      need(b.attacked);
      expect(b.w.verdict()).toMatchObject({ status: 'failed', failures: ['commitChangedAfter'] });
    }));
});

/** A table client on a link that goes nowhere, with the private records the tests below fill and read. */
interface Records {
  tamper: Map<number, string[]>;
  commitSets: Array<{ hand: number; commits: Array<{ seat: number; hash: string }> }>;
  records: CeremonyRecord[];
  plays: PlayRecord[];
  rewinds: Array<{ hand: number; tc: number; undone: boolean }>;
  handsEnded: Set<number>;
  ownAbsences: number[];
  gapVerdicts: Array<{ at: number; ok: boolean }>;
  openHand: number | null;
  flag(hand: number, problem: string): void;
  holdSet(hand: number, commits: Array<{ seat: number; hash: string }>): void;
  playFor(hand: number): PlayRecord;
  trimHands<T>(list: T[], max: number, handOf: (x: T) => number): void;
  noteOwnAbsence(epoch: number): void;
}
const nowhere = (): Link => ({ send: () => undefined, onMessage: () => () => undefined, close: () => undefined });
const recs = (c: TableClient) => c as unknown as Records;
const ON = 7;

/** A client on hand 7 whose every per-hand collection has been filled past its cap, the hand on show first each time. */
function filled(): TableClient {
  const c = new TableClient(nowhere(), 'Victim', undefined, {}, { now: () => 5_000_000 });
  const r = recs(c);
  (c as unknown as { state: TableClient['state'] }).state = { ...c.state, seat: 0, matchId: 'm-HR', roomCode: 'HR', token: 'a'.repeat(32) };
  r.openHand = ON;
  r.flag(ON, 'Hand started with scores different from where the previous hand left them');
  for (let h = 100; h < 115; h++) r.flag(h, 'Host sent a frame about a hand or turn this device was not on');
  r.holdSet(ON, madeUp());
  for (let h = 100; h < 105; h++) r.holdSet(h, madeUp());
  const play = r.playFor(ON);
  for (let h = 100; h < 105; h++) r.playFor(h);
  r.records.push({ hand: ON, attempts: [{ n: 1, committed: true, revealed: true, stoodIn: false }], fromStart: true, linkLost: false, dealt: true });
  for (let h = 100; h < 105; h++) {
    r.records.push({ hand: h, attempts: [], fromStart: false, linkLost: true, dealt: false });
    r.trimHands(r.records, 3, (x) => x.hand);
  }
  r.rewinds.push({ hand: ON, tc: 3, undone: true });
  for (let h = 100; h < 106; h++) {
    r.rewinds.push({ hand: h, tc: -1, undone: false });
    r.trimHands(r.rewinds, 4, (x) => x.hand);
  }
  for (let h = 200; h < 260; h++) r.handsEnded.add(h);
  for (let e = 0; e < 20; e++) r.noteOwnAbsence(e);
  // The table-move checks' verdicts on stretches without a link, as `judgeTableMove` keeps them (the last 8).
  for (let k = 0; k < 12; k++) {
    r.gapVerdicts.push({ at: 1_000 * k, ok: k % 2 === 0 });
    if (r.gapVerdicts.length > 8) r.gapVerdicts.shift();
  }
  // What the match's audits, passed claims and late turns hold, the audits as the client caps them (`MAX_AUDITS`).
  const audit = { matchId: 'm-HR', handNumber: 0, seed: 's', commits: [], reveals: [], log: [], finalHash: 'h', rngVersion: 'v', ceremonyAttempts: 1, restarts: [], restartReasons: [] };
  const audits = Array.from({ length: 60 }, (_, k) => ({ audit: { ...audit, handNumber: 200 + k }, status: 'ok' as const, failures: [], caveats: [] })).slice(-MAX_AUDITS);
  (c as unknown as { state: TableClient['state'] }).state = {
    ...c.state,
    audits,
    claimsPassedAway: Array.from({ length: 20 }, (_, k) => ({ hand: 200 + k, turn: k, claim: 'pong' as const })),
    turnsShownLate: Array.from({ length: 20 }, (_, k) => ({ hand: 200 + k, late: [k], of: k + 1 })),
  };
  // The hand on show's own record: more states, moves and answers to pings than it keeps.
  for (let k = 0; k < 650; k++) {
    play.seen.push({ tc: k, epoch: 1, era: 0, at: 1_000 + k, now: 900 + k, run: 'run1', onLink: true, owes: k % 4 === 0, deadline: 20_000 + k, timeBank: 30, inBank: false, hash: `h${k}`, view: `${k}`.padStart(32, '0') });
    keepSeen(play);
  }
  for (let k = 0; k < 320; k++) {
    play.sent.push({ tc: k, action: { type: 'discard', tile: k % 136 }, epoch: 1, at: 1_000 + k, run: 'run1', seg: 0 });
    if (play.sent.length > MAX_SENT) play.sent.splice(0, play.sent.length - MAX_SENT);
  }
  play.refusals = Array.from({ length: MAX_SENT }, (_, k) => ({ tc: k, at: k + 1 }));
  play.pongs = Array.from({ length: 30 }, (_, k) => ({ at: 1_000 + 1_000 * k, now: 1_050 + 1_000 * k, era: 0, run: 'run1', seg: 0, fat: 1_100 + 1_000 * k }));
  play.pingedFrom = Array.from({ length: 16 }, (_, k) => ({ era: k, run: 'run1', seg: 0, at: 1_000 + k }));
  play.pinged = 30;
  play.ledgerFrom = 0;
  return c;
}

/** What each collection of `c` holds, as a test compares it before and after a save. */
function holdings(c: TableClient) {
  const r = recs(c);
  const play = r.plays.find((p) => p.hand === ON)!;
  return {
    tamper: [...r.tamper.entries()].sort((a, b) => a[0] - b[0]),
    commitSets: r.commitSets.map((x) => [x.hand, x.commits.map((k) => k.hash).join()]),
    records: r.records.map((x) => [x.hand, x.attempts.length]),
    plays: r.plays.map((p) => p.hand),
    rewinds: r.rewinds.map((x) => [x.hand, x.tc, x.undone]),
    handsEnded: [...r.handsEnded].sort((a, b) => a - b),
    seen: play.seen.map((f) => [f.tc, f.hash, f.view, f.deadline]),
    overflow: play.overflow,
    sent: play.sent.map((x) => x.tc),
    refusals: play.refusals,
    pongs: (play.pongs ?? []).map((k) => [k.at, k.now, k.fat]),
    pingedFrom: (play.pingedFrom ?? []).map((k) => k.at),
    pinged: play.pinged,
    gapVerdicts: r.gapVerdicts.map((g) => [g.at, g.ok]),
    audits: c.state.audits.map((a) => a.audit.handNumber),
    claimsPassedAway: c.state.claimsPassedAway,
    turnsShownLate: c.state.turnsShownLate,
  };
}

describe('the saved record keeps what memory keeps', () => {
  it('every collection the record saves, filled past its cap with the hand on show first, comes back from the record as memory holds it, the hand on show in each', () => {
    const c = filled();
    const r = recs(c);
    // Memory holds each collection to its cap without giving up the hand on show.
    expect(r.tamper.size).toBe(12);
    expect(r.tamper.has(ON)).toBe(true);
    expect(r.commitSets.map((x) => x.hand)).toContain(ON);
    expect(r.plays.map((x) => x.hand)).toContain(ON);
    expect(r.records.map((x) => x.hand)).toContain(ON);
    expect(r.rewinds.map((x) => x.hand)).toContain(ON);
    expect([r.gapVerdicts.length, c.state.audits.length]).toEqual([8, MAX_AUDITS]);
    const saved = JSON.parse(JSON.stringify(c.serialize())) as SerializedClient;
    const back = TableClient.restore(saved, nowhere(), 'Victim', undefined, { token: saved.state.token ?? undefined }, { now: () => 5_000_000 });
    const before = holdings(c);
    const after = holdings(back);
    for (const key of Object.keys(before) as Array<keyof typeof before>) expect(after[key], key).toEqual(before[key]);
    // (A restored client adds its own restart to these, so the record itself is compared.)
    expect(saved.clock?.ownAbsences).toEqual(r.ownAbsences);
    expect(r.ownAbsences).toHaveLength(16);
    // Saved again, the record is the same.
    const again = JSON.parse(JSON.stringify(back.serialize())) as SerializedClient;
    expect(again.tamper).toEqual(saved.tamper);
    expect(again.commitSets).toEqual(saved.commitSets);
    expect(again.handsEnded).toEqual(saved.handsEnded);
  });

  it('the flags of the hand on show survive a restart while twelve hands are flagged (the record once kept the last eight)', () => {
    const c = filled();
    const saved = JSON.parse(JSON.stringify(c.serialize())) as SerializedClient;
    const back = TableClient.restore(saved, nowhere(), 'Victim', undefined, { token: saved.state.token ?? undefined }, { now: () => 5_000_000 });
    expect(recs(back).tamper.get(ON)).toEqual(['Hand started with scores different from where the previous hand left them']);
  });

  it('a record saved before the sets were kept per hand restores its one set under its hand; a damaged set or flag is not read back', () => {
    const c = filled();
    const saved = JSON.parse(JSON.stringify(c.serialize())) as SerializedClient & { commitSets?: unknown };
    const set = madeUp();
    delete saved.commitSets;
    saved.commits = set;
    saved.commitsHand = ON;
    (saved as unknown as { tamper: unknown[] }).tamper = [[ON, ['kept', 5]], ['x', ['dropped']], null, [8, 'dropped']];
    const back = TableClient.restore(saved, nowhere(), 'Victim', undefined, { token: saved.state.token ?? undefined }, { now: () => 5_000_000 });
    expect(recs(back).commitSets).toEqual([{ hand: ON, commits: set }]);
    expect([...recs(back).tamper.entries()]).toEqual([[ON, ['kept']]]);
  });
});

/**
 * Normal. On the seat's second discard turn, half a second after the phone was shown it, the host plays a discard the
 * seat would not make, logged as the seat's own. Once the phone has been shown three turns past it, and again each time
 * the restored app has been shown three more, the server says the seat was opened on another device: the app saves at
 * once and the player resumes from Home a second later, `kicks` times in all. Each notice closes the ledger into a
 * stretch it still vouches for; the first holds the forged move.
 */
function vouched(code: string, kicks: number) {
  let forged: number | null = null;
  let done = 0;
  let lastTc = -1;
  let resumeAt: number | null = null;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 2_000,
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing') return;
      if (resumeAt !== null && w.clock.now >= resumeAt) {
        resumeAt = null;
        w.restart();
        return;
      }
      if (forged === null && w.discardTurn() && w.current() && mineMoves(w) >= 1 && w.clock.now - (w.shown.get(g.turnCounter) ?? Infinity) >= 500) {
        const h = w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };
        const timeout = h.timeoutAction(g, 0);
        const move = legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, timeout, g, 0));
        if (!move) return;
        forged = g.turnCounter;
        lastTc = forged;
        h.apply(0, move, 'player');
        return;
      }
      // This run of the app has been shown three turns of the hand past the last notice: its stretch covers turns.
      const c = w.c as unknown as { plays: PlayRecord[]; runId: string };
      const turns = new Set((c.plays.find((p) => p.hand === 0)?.seen ?? []).filter((f) => f.run === c.runId && f.tc > lastTc).map((f) => f.tc));
      if (forged !== null && done < kicks && resumeAt === null && !w.c.state.kicked && turns.size >= 3) {
        done++;
        lastTc = Math.max(...turns);
        w.line.inject({ t: 'disconnected' } as HostMessage);
        resumeAt = w.clock.now + 1_000;
      }
    },
  });
  w.finish();
  const spans = (w.c as unknown as { plays: PlayRecord[] }).plays.find((p) => p.hand === 0)?.vouched ?? [];
  return { w, forged, done, spans };
}

describe('the stretches the ledger vouches for', () => {
  it('nine seat-taken notices with resumes after a move forged in the seat’s name: red, the stretch that holds it is kept; one notice: red too', () =>
    scenario((i) => {
      const a = vouched(`HRV${i}`, 9);
      need(a.forged !== null && a.done === 9);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['moveInvented']));
      expect(a.spans.some((v) => v.from <= a.forged! && a.forged! < v.to)).toBe(true);
      const b = vouched(`HRV${i}`, 1);
      need(b.forged !== null && b.done === 1);
      expect(b.w.verdict().failures).toEqual(expect.arrayContaining(['moveInvented']));
    }), 30_000);

  it('stretches that touch or overlap are kept as one, and stretches of different turns stay apart', () => {
    const c = new TableClient(nowhere(), 'Victim', undefined, {}, { now: () => 5_000_000 });
    const r = c as unknown as { plays: PlayRecord[]; runId: string; playFor(h: number): PlayRecord; closeLedger(p: PlayRecord): void };
    const play = r.playFor(0);
    const close = (from: number, to: number) => {
      play.ledgerFrom = from;
      play.seen = [{ tc: to, epoch: 0, at: 0, run: r.runId, owes: false, deadline: null, timeBank: 0, inBank: false, hash: 'x' }];
      r.closeLedger(play);
    };
    for (let k = 0; k < 20; k++) close(10 * k, 10 * k + 5);
    expect(play.vouched).toHaveLength(20);
    close(5, 10);
    close(3, 12);
    expect(play.vouched?.slice(0, 2)).toEqual([{ from: 0, to: 15 }, { from: 20, to: 25 }]);
    expect(play.vouched).toHaveLength(19);
  });
});
