/**
 * Every move credited to the player is one this device sent, written down before it went out.
 *
 * With the app's journal (`TableClientOptions.writeAhead`), `act` files a move, hands it to the journal, and sends it only
 * once the journal has it. A client restored from the record and the journal then knows every move this device sent, so
 * the ledger of a hand under way runs on across an app restart or a resume from Home: a move credited to the player that
 * the device never sent fails the hand (`moveInvented`), whenever the server shows the table again. Without a journal a
 * restored client vouches again only from the next state it is shown, as before (the stated limit), but an honest host
 * sends that state right behind its welcome, before it answers the ping behind the join: a later turn that comes after
 * such an answer was held back, and a move credited to the seat from there fails the hand (`heldFrame`).
 */
import { describe, expect, it } from 'vitest';
import { legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import { LoopbackHub, TableClient, TableHost, transportLink, type ClientMessage, type HostMessage, type JournalEntry, type Link, type SerializedClient } from '../src/index';
import { Missed, scenario, scenarioAsync, seededDeals } from './support';
import { runScenario } from './adversary/fuzz';
import type { Scenario } from './adversary/scenario';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const host = (w: Wire) => w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };
/** The seat's own moves in the hand so far. */
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;
/** A legal discard of the seat's that the table's timeout rule would not make. */
const otherDiscard = (w: Wire): Action | undefined => {
  const g = w.host.game!;
  const timeout = host(w).timeoutAction(g, 0);
  return legalActions(g, 0).find((a) => a.type === 'discard' && !sameAction(a, timeout, g, 0));
};

/** An in-process table whose phone keeps the journal `hook` writes to: what the phone sends, in order, with the journal's writes. */
function table(code: string, hook?: (e: JournalEntry, log: string[]) => void | Promise<void>) {
  const log: string[] = [];
  const hub = new LoopbackHub();
  const t = new TableHost(hub.create('host'), { roomCode: code, rules: NORMAL, matchId: `m-${code}` });
  const base = transportLink(hub.create('pA'), 'host');
  const link: Link = { ...base, send: (m: ClientMessage) => (log.push(`send ${m.t}`), base.send(m)) };
  const c = new TableClient(link, 'A', undefined, {}, hook ? { writeAhead: (e) => hook(e, log) } : {});
  c.join();
  t.start();
  const move = (): Action => legalActions(c.localState()!, 0)[0];
  const filed = () => (c.serialize().plays.find((p) => p.hand === 0)?.sent ?? []).length;
  return { c, t, log, move, filed };
}

describe('the journal is written before the move goes out', () => {
  it('a journal that keeps the move: written first, then sent; the entry carries the move, its place and its hand', () => {
    const entries: JournalEntry[] = [];
    const a = table('WA1', (e, log) => {
      log.push(`journal ${e.seq}`);
      entries.push(e);
    });
    need(a.c.state.view !== null && legalActions(a.c.localState()!, 0).length > 0);
    a.log.length = 0;
    const mv = a.move();
    a.c.act(mv);
    expect(a.log).toEqual(['journal 1', 'send action']);
    expect(entries[0]).toMatchObject({ seq: 1, matchId: 'm-WA1', hand: 0, tc: a.c.state.view!.turnCounter > 0 ? expect.any(Number) : 0, action: mv, from: 0 });
    expect(a.c.serialize()).toMatchObject({ sentSeq: 1 });
  });

  it('a journal that cannot keep it (the write throws): the move is not sent, and is taken off the record', () => {
    const a = table('WA2', () => {
      throw new Error('storage full');
    });
    need(a.c.state.view !== null && legalActions(a.c.localState()!, 0).length > 0);
    a.log.length = 0;
    a.c.act(a.move());
    expect(a.log).toEqual([]);
    expect(a.filed()).toBe(0);
    expect(a.c.state.lastError).toMatch(/could not be saved/);
    expect(a.c.state.lastErrorCode).toBe('move_unsaved');
  });

  it('a journal written later (a promise): the move goes out once it is written, and not at all if the write fails', async () =>
    scenarioAsync(async () => {
      let done: () => void = () => undefined;
      let fail: () => void = () => undefined;
      const a = table('WA3', (e, log) => {
        log.push(`journal ${e.seq}`);
        return new Promise<void>((res, rej) => {
          done = res;
          fail = () => rej(new Error('storage full'));
        });
      });
      need(a.c.state.view !== null && legalActions(a.c.localState()!, 0).length > 0);
      a.log.length = 0;
      a.c.act(a.move());
      const moves = (log: string[]) => log.filter((x) => x !== 'send ping');
      expect(moves(a.log)).toEqual(['journal 1']);
      done();
      await Promise.resolve();
      await Promise.resolve();
      expect(moves(a.log)).toEqual(['journal 1', 'send action']);

      const b = table('WA4', (e, log) => {
        log.push(`journal ${e.seq}`);
        return new Promise<void>((res, rej) => {
          done = res;
          fail = () => rej(new Error('storage full'));
        });
      });
      need(b.c.state.view !== null && legalActions(b.c.localState()!, 0).length > 0);
      b.log.length = 0;
      b.c.act(b.move());
      fail();
      await Promise.resolve();
      await Promise.resolve();
      expect(moves(b.log)).toEqual(['journal 1']);
      expect(b.filed()).toBe(0);

      // Written only once the link it was made on is gone: not sent on the new one, and off the record (it vouches for nothing).
      const c = table('WA4b', (e, log) => {
        log.push(`journal ${e.seq}`);
        return new Promise<void>((res) => {
          done = res;
        });
      });
      need(c.c.state.view !== null && legalActions(c.c.localState()!, 0).length > 0);
      c.log.length = 0;
      c.c.act(c.move());
      expect(c.filed()).toBe(1);
      const hub2 = new LoopbackHub();
      const sentThere: string[] = [];
      const base2 = transportLink(hub2.create('pA2'), 'host');
      c.c.rebind({ ...base2, send: (m: ClientMessage) => (sentThere.push(m.t), base2.send(m)) });
      done();
      await Promise.resolve();
      await Promise.resolve();
      expect(moves(c.log)).toEqual(['journal 1']);
      expect(sentThere).not.toContain('action');
      expect(c.filed()).toBe(0);
    }));

  it('no journal: the move goes out at once, as before, with no place', () => {
    const a = table('WA5');
    need(a.c.state.view !== null && legalActions(a.c.localState()!, 0).length > 0);
    a.log.length = 0;
    a.c.act(a.move());
    expect(a.log).toEqual(['send action']);
    const rec = a.c.serialize();
    expect(rec.sentSeq).toBeUndefined();
    expect(rec.plays.find((p) => p.hand === 0)?.sent[0]?.seq).toBeUndefined();
  });
});

/**
 * Normal. Half a second into the seat's third discard turn (it moves 3 s in), the server plays a legal discard the seat
 * would not make, written down as the player's own, and the app restarts at once from the record (`restart`): before any
 * later state reached it. `journal`: the app keeps the journal. `edit` changes what the journal holds first.
 */
function forgedThenRestart(code: string, journal: boolean, edit?: (j: JournalEntry[]) => void, lost = false) {
  let forged: { tc: number } | null = null;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 3_000,
    journal,
    onTick: (w) => {
      const g = w.host.game;
      if (forged !== null || !g || w.host.phase !== 'playing') return;
      if (!w.discardTurn() || !w.current() || mine(w) < 2 || w.clock.now - (w.shown.get(g.turnCounter) ?? Infinity) < 500) return;
      const move = otherDiscard(w);
      if (!move) return;
      forged = { tc: g.turnCounter };
      host(w).apply(0, move, 'player');
      edit?.(w.journal);
      w.restart(undefined, undefined, lost);
    },
  });
  w.finish();
  const entry = forged ? w.c.state.lastAudit?.log.find((e) => e.seat === 0 && e.n === forged!.tc) : undefined;
  return { w, forged: !!entry && entry.source === 'player' };
}

/**
 * Normal. The seat makes its third move and `moves - 1` more, the table plays them, and the app restarts from the record
 * it wrote before the third (an app saves a moment after a change: those moves are not in it). `journal`: the app keeps
 * the journal. `edit` changes what the journal holds first (`after`: the place of the record's last move).
 */
function ownMoveThenStaleRestart(code: string, journal: boolean, edit?: (j: JournalEntry[], after: number) => void, moves = 1, lost = false) {
  let prev: SerializedClient | null = null;
  let restarted = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    journal,
    onTick: (w) => {
      const g = w.host.game;
      if (restarted || !g || w.host.phase !== 'playing') return;
      if (mine(w) >= 2 + moves && prev) {
        restarted = true;
        edit?.(w.journal, prev.sentSeq ?? 0);
        w.restart(undefined, prev, lost);
        return;
      }
      // The record as the app last wrote it: before the seat's third move.
      if (mine(w) <= 2) prev = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
    },
  });
  w.finish();
  return { w, restarted };
}

describe('a client restored with the journal knows every move this device sent', () => {
  it('a move forged in the player’s name, then an app restart before any later state: red with the journal (a move the seat never made)', () =>
    scenario((i) => {
      const a = forgedThenRestart(`WJF${i}`, true);
      need(a.forged);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['moveInvented'] });
    }));

  it('control: the same without the journal is not checked (the stated limit: the move may be one the app sent after its last save)', () =>
    scenario((i) => {
      const a = forgedThenRestart(`WJN${i}`, false);
      need(a.forged);
      expect(a.w.verdict().failures).not.toEqual(expect.arrayContaining(['moveInvented']));
    }));

  it('honest: the seat’s own move after the last save is in the journal, so a restore from that older record does not take it for a forged one', () =>
    scenario((i) => {
      const a = ownMoveThenStaleRestart(`WJO${i}`, true);
      need(a.restarted);
      expect(a.w.verdict().failures).toEqual([]);
      expect(a.w.journal.length).toBeGreaterThanOrEqual(3);
    }));

  it('a journal storage changed (an entry’s move is not the one written) vouches for nothing: no move is held against the table', () =>
    scenario((i) => {
      const a = ownMoveThenStaleRestart(`WJD${i}`, true, (j) => {
        const e = j[j.length - 1];
        if (e) j[j.length - 1] = { ...e, tc: e.tc + 1 };
      });
      need(a.restarted);
      expect(a.w.verdict().failures).toEqual([]);
    }));

  it('a journal that lost a move between the record’s last one and its own last entry vouches for nothing either', () =>
    scenario((i) => {
      let lost = false;
      const a = ownMoveThenStaleRestart(
        `WJG${i}`,
        true,
        (j, after) => {
          const k = j.findIndex((e) => e.seq === after + 1);
          if (k >= 0 && j.some((e) => e.seq > after + 1)) {
            j.splice(k, 1);
            lost = true;
          }
        },
        2,
      );
      need(a.restarted && lost);
      expect(a.w.verdict().failures).toEqual([]);
    }));

  it('a forged move under a damaged journal: not held against the table (damaged storage never fails a hand), but amber and the end not verified', () =>
    scenario((i) => {
      const a = forgedThenRestart(`WJX${i}`, true, (j) => {
        const e = j[j.length - 1];
        if (e) j[j.length - 1] = { ...e, at: e.at + 1 };
      });
      need(a.forged);
      expect(a.w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(a.w.verdict().caveats).toContain('journalLost');
    }));

  it('a record this build wrote, restored with no list of its match in the journal: the forged move is amber and the end of the match not verified, never green', () =>
    scenario((i) => {
      const a = forgedThenRestart(`WJL${i}`, true, undefined, true);
      need(a.forged);
      expect(a.w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(a.w.verdict().caveats).toContain('journalLost');
      a.w.c.ready();
      for (let e = 0; e < 600_000 && !a.w.c.state.matchOver; e += 500) a.w.step();
      expect([a.w.c.state.matchOver, a.w.c.state.matchEndVerified]).toEqual([true, false]);
    }));

  it('honest: the seat’s own move after the last save, then a restore with no list: never red, amber (the phone cannot tell it from a forged one)', () =>
    scenario((i) => {
      const a = ownMoveThenStaleRestart(`WJLH${i}`, true, undefined, 1, true);
      need(a.restarted);
      expect(a.w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(a.w.verdict().caveats).toContain('journalLost');
    }));
});

/**
 * Normal. Once the seat has made two moves and owes nothing, the app restarts (`restart`). On the new link the server
 * welcomes it and answers its pings, but sends no state (`hold`); meanwhile, half a second into each discard the seat
 * owes, it plays a legal one the seat would not make, written down as the player's own (`forge`). After two of them (or,
 * with nothing to forge, 2 s), at the first moment the seat owes nothing, it sends the table as it stands: a fresh state
 * (the states of the turns it held are never sent). `journal`: the app keeps the journal.
 */
function restartThenHold(code: string, opts: { journal: boolean; hold: boolean; forge: boolean }) {
  let restarted = false;
  let holding = false;
  let heldFrom = 0;
  let owedInHold = false;
  let forged = 0;
  let owedSince: { tc: number; at: number } | null = null;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 3_000,
    journal: opts.journal,
    map: (m, w) => (holding && w.line.id !== 'p0' && (m.t === 'state' || m.t === 'clock') ? null : m),
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing') return;
      if (!restarted) {
        if (mine(w) < 2 || w.owes() || w.c.state.view?.turnCounter !== g.turnCounter) return;
        restarted = true;
        holding = opts.hold;
        heldFrom = w.clock.now;
        w.restart();
        return;
      }
      if (holding && w.owes()) owedInHold = true;
      if (holding && !w.owes() && (opts.forge ? forged >= 2 : w.clock.now - heldFrom >= 2_000)) {
        holding = false;
        w.line.inject((w.host as unknown as { stateMsg(seat: number): HostMessage }).stateMsg(0));
        return;
      }
      if (!opts.forge || forged >= 2) return;
      // Without a hold, only once the restored phone has been shown the table again.
      if (!opts.hold && w.c.state.view?.turnCounter !== g.turnCounter) return;
      if (!w.discardTurn()) {
        owedSince = null;
        return;
      }
      if (!owedSince || owedSince.tc !== g.turnCounter) owedSince = { tc: g.turnCounter, at: w.clock.now };
      if (w.clock.now - owedSince.at < 500) return;
      const move = otherDiscard(w);
      if (!move) return;
      host(w).apply(0, move, 'player');
      forged++;
    },
  });
  w.finish();
  return { w, restarted, forged, owedInHold };
}

describe('after an app restart, the server holds the table back and plays in the player’s name', () => {
  it('without the journal: red, the state the table owed right behind its welcome came after its answer to a ping (it was held back)', () =>
    scenario((i) => {
      const a = restartThenHold(`WHN${i}`, { journal: false, hold: true, forge: true });
      need(a.restarted && a.forged >= 1);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['heldFrame']));
    }));

  it('with the journal: red, a move the seat never made', () =>
    scenario((i) => {
      const a = restartThenHold(`WHJ${i}`, { journal: true, hold: true, forge: true });
      need(a.restarted && a.forged >= 1);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['moveInvented']));
    }));

  it('control: the same moves once the table was shown again are red either way', () =>
    scenario((i) => {
      for (const journal of [false, true]) {
        const a = restartThenHold(`WHS${journal}${i}`, { journal, hold: false, forge: true });
        need(a.restarted && a.forged >= 1);
        expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['moveInvented'] });
      }
    }));

  it('honest: a restart, the state right behind the welcome, nothing forged: no failure, with or without the journal', () =>
    scenario((i) => {
      for (const journal of [false, true]) {
        const a = restartThenHold(`WHH${journal}${i}`, { journal, hold: false, forge: false });
        need(a.restarted);
        expect(a.w.verdict().failures).toEqual([]);
      }
    }));

  it('a hold of 2 s alone, the seat owing nothing in it: nothing fails', () =>
    scenario((i) => {
      const a = restartThenHold(`WHO${i}`, { journal: false, hold: true, forge: false });
      need(a.restarted && !a.owedInHold);
      expect(a.w.verdict().failures).toEqual([]);
    }));
});

describe('a journal write that takes long (a phone whose storage is slow)', () => {
  /**
   * Normal, an honest table. The journal's write of the seat's `k`-th move takes `delayMs` on the table's clock (the writes
   * after it wait behind it, as the app chains them); the others end at once. Each move goes out once it is written, so the
   * slow one goes out late, and the table plays its own move for the seat once the clock has run out.
   */
  async function slow(code: string, k: number, delayMs: number) {
    const due: Array<{ at: number; done: () => void }> = [];
    let chain: Promise<void> = Promise.resolve();
    let n = 0;
    const w = wire({
      code,
      rules: NORMAL,
      botDelayMs: 700,
      journal: true,
      journalWrite: (_e, w) => {
        const wait = ++n === k ? delayMs : 0;
        chain = chain.then(() => new Promise<void>((done) => (wait === 0 ? done() : due.push({ at: w.clock.now + wait, done }))));
        return chain;
      },
      onTick: (w) => {
        for (let i = 0; i < due.length; ) {
          if (due[i].at <= w.clock.now) due.splice(i, 1)[0].done();
          else i++;
        }
      },
    });
    const flush = () => new Promise<void>((r) => setImmediate(r));
    for (let e = 0; e < 3_600_000 && w.host.phase !== 'hand_over' && w.host.phase !== 'match_over'; e += 500) {
      w.step();
      await flush();
    }
    for (let e = 0; e < 120_000 && w.c.state.lastResult === null; e += 500) {
      w.step();
      await flush();
    }
    return { w, slowFiled: n >= k };
  }

  it('writes of 31 s and 45 s: the move goes out late and the table has played its own; no hand red (a move is timed from when it went out)', async () => {
    const verdicts: Array<ReturnType<Wire['verdict']>> = [];
    for (const [code, k, ms] of [
      ['WS1', 3, 45_000],
      ['WS2', 3, 45_000],
      ['WS3', 4, 45_000],
      ['WS4', 3, 31_000],
      ['WS5', 2, 45_000],
      ['WS6', 3, 60_000],
    ] as const) {
      const { w, slowFiled } = await slow(code, k, ms);
      need(slowFiled && w.c.state.lastAudit !== null);
      verdicts.push(w.verdict());
    }
    expect(verdicts.filter((v) => v.status === 'failed')).toEqual([]);
  });
});

describe('a journal write that outlasts its hand (a phone whose storage is very slow)', () => {
  // Found by unit 20h's check: every write of the journal takes 5 s (Hyper) or 40 s (Normal), each waiting behind the one
  // before, as the app chains them. Moves made late in a hand were written, and went out, after that hand had ended, and
  // the honest table played one in the next hand, whose record does not hold it (red, moveChanged). A move whose hand is
  // over by the time the journal has it is not sent (as one whose link is gone): the table plays its own move for the seat.
  const player = { thinkMs: [800, 2500], retry: { kind: 'other', afterMs: 500 }, readyMs: 1000 };
  const cases: Array<[string, Scenario]> = [
    ['sj-hyper-deal0-5000', { seed: 969601, speed: 'hyper', hands: 3, othersPresent: true, botDelayMs: 300, player, events: [{ at: { on: 'deal', hand: 0, ms: 1 }, do: { a: 'slowJournal', ms: 5000, forMs: 120000 } }] } as Scenario],
    ['app-normal-res0-slow40-only', { seed: 959501, speed: 'normal', hands: 3, othersPresent: true, botDelayMs: 300, player, events: [{ at: { on: 'result', hand: 0, ms: 1 }, do: { a: 'slowJournal', ms: 40000, forMs: 90000 } }] } as Scenario],
  ];
  it.each(cases)('%s: no hand red, and no move goes out after its hand', (_name, s) => {
    const o = runScenario(s);
    expect([...o.judgement.verdicts.values()].filter((v) => v.status === 'failed').map((v) => v.failures)).toEqual([]);
    expect(o.judgement.violations.map((v) => v.property)).not.toContain('falseRed');
  });
});
