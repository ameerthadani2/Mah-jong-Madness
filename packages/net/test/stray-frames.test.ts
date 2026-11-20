/**
 * Frames that name a hand or a turn the phone is not on.
 *
 * The phone files what a frame says under the hand the frame names. An honest host names only the hand being played
 * or dealt, at the point where it sends each frame (`TableHost`): a clock frame names the turn whose state it last
 * sent the link; a deal's frames name the hand being dealt; a restart notice is a returning link's first word and
 * names the hand the restored table resumed (or the next one, before its deal); a refusal answers this seat's move in
 * the hand being played. A frame naming any other hand is the server's doing: it makes, changes and pushes out no
 * record, and the hand the phone is on fails.
 */
import { describe, expect, it } from 'vitest';
import { legalActions, withRules, type Action, type GameState } from '@mjm/engine';
import { caveatKey, failureKey, type HostMessage, type TableClient } from '../src/index';
import type { PlayRecord } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const plays = (c: TableClient) => (c as unknown as { plays: PlayRecord[] }).plays;
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
/** The host's own move for a seat, as its clock running out would make it. */
const tableMove = (w: Wire) => {
  const h = w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };
  h.apply(0, h.timeoutAction(w.host.game!, 0), 'timeout');
};
const mine = (w: Wire) => w.host.game!.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length;

/**
 * Normal. Once the seat has made three moves, the table plays its next turn (not a claim) for it 2 s after the phone
 * was shown it, long before its clock ran out. Once the seat has moved again and owes nothing, the server sends
 * `stray` clock frames, each for a hand never dealt (9001, 9002, ...), stamped long before every other frame of the
 * link: a frame stamped more than a second behind the link's latest is a frame held back, and was once filed under
 * the hand it names, making a record of it that pushed the hand on show out of the three the phone keeps.
 */
function earlyThenStray(code: string, stray: number) {
  let playedAt: number | null = null;
  let movesThen: number | null = null;
  let sent = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 5_000,
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing') return;
      if (playedAt === null && w.current() && mine(w) >= 3 && g.phase !== 'claim' && w.clock.now - (w.shown.get(g.turnCounter) ?? Infinity) >= 2_000) {
        tableMove(w);
        playedAt = w.clock.now;
        movesThen = mine(w);
      }
      if (playedAt !== null && !sent && movesThen !== null && mine(w) >= movesThen + 1 && !w.owes()) {
        sent = true;
        for (let j = 1; j <= stray; j++) w.line.inject({ t: 'clock', now: 1, hand: 9000 + j, tc: 0 } as HostMessage);
      }
    },
  });
  w.finish();
  return { w, played: playedAt !== null, sent };
}

describe('clock frames for a hand the phone is not on', () => {
  it('Normal, the table plays the seat’s turn 2 s after it was shown, then three clock frames for hands never dealt, stamped long ago: red, with the early move named; no record of those hands is made; the same red without the frames', () =>
    scenario((i) => {
      const a = earlyThenStray(`SCE${i}`, 3);
      need(a.played && a.sent);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['playedEarly', 'strayFrame']));
      expect(plays(a.w.c).map((p) => p.hand)).not.toEqual(expect.arrayContaining([9001]));
      const b = earlyThenStray(`SCE${i}`, 0);
      need(b.played);
      expect(b.w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));

  it('a clock frame for an earlier turn of the hand than the phone was last shown, or for another hand, fails the hand; one for the turn it was shown does not', () =>
    scenario((i) => {
      const run = (frame: (w: Wire) => HostMessage | null) => {
        let sent = false;
        const w = wire({
          code: `SCT${i}`,
          rules: NORMAL,
          botDelayMs: 700,
          onTick: (w) => {
            const v = w.c.state.view;
            if (sent || !v || mine(w) < 2 || w.host.phase !== 'playing' || v.turnCounter !== w.host.game!.turnCounter) return;
            const m = frame(w);
            sent = true;
            if (m) w.line.inject(m);
          },
        });
        w.finish();
        need(sent);
        return w.verdict();
      };
      const now = (w: Wire) => (w.host as unknown as { stamp(): number }).stamp();
      const tc = (w: Wire) => w.c.state.view!.turnCounter;
      expect(run((w) => ({ t: 'clock', now: now(w), hand: 0, tc: tc(w) - 1 }) as HostMessage)).toMatchObject({ status: 'failed', failures: ['strayFrame'] });
      expect(run((w) => ({ t: 'clock', now: now(w), hand: 1, tc: tc(w) }) as HostMessage)).toMatchObject({ status: 'failed', failures: ['strayFrame'] });
      expect(run((w) => ({ t: 'clock', now: now(w), hand: 0, tc: tc(w) }) as HostMessage)).toEqual({ status: 'ok', failures: [], caveats: [] });
      expect(run(() => null)).toEqual({ status: 'ok', failures: [], caveats: [] });
    }));
});

/**
 * Normal. Once the seat has made three moves the app restarts, restored from a record whose last-made hand record is
 * another hand's (`other`; the order a server once brought about with one stray clock frame). Then the server refuses
 * the seat's next discard as illegal (it never reaches the table) though it is legal, and the seat, told so, discards
 * another tile, which the table plays.
 */
function refusedAfterRestart(code: string, other: boolean) {
  let armed = false;
  let refused: { tc: number; action: Action } | null = null;
  let retried = false;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 1_000,
    upFilter: (m, w) => {
      if (!armed || refused || m.t !== 'action' || m.action.type !== 'discard' || typeof m.turnCounter !== 'number') return true;
      refused = { tc: m.turnCounter, action: m.action };
      w.line.inject({ t: 'error', code: 'illegal', message: 'That move is not allowed now.', turnCounter: m.turnCounter } as HostMessage);
      return false;
    },
    onTick: (w) => {
      if (!refused || retried || w.c.state.lastErrorCode !== 'illegal') return;
      const s = w.c.localState();
      if (!s || s.turnCounter !== refused.tc) return;
      const first = JSON.stringify(refused.action);
      const another = legalActions(s, 0).find((a) => a.type === 'discard' && JSON.stringify(a) !== first);
      if (!another) return;
      retried = true;
      w.c.act(another);
    },
  });
  need(w.toDiscard(3));
  w.restart((saved) => {
    if (other) saved.plays.push({ hand: 9001, seen: [], sent: [], ledgerFrom: 2 } as never);
    return saved;
  });
  const ledgerAfterRestart = plays(w.c).find((p) => p.hand === 0)?.ledgerFrom;
  armed = true;
  w.finish();
  need(retried);
  return { w, ledgerAfterRestart };
}

describe('the hand a refusal, an app restart and the seat-taken notice are held against', () => {
  it('Normal, the app restarted from a record whose last-made hand record is another hand’s, then a legal discard refused: red legalMoveRefused, as without that record; the restored client vouches for the hand on show only from its next state', () =>
    scenario((i) => {
      const a = refusedAfterRestart(`SRF${i}`, true);
      expect(a.ledgerAfterRestart).toBe(Number.POSITIVE_INFINITY);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['legalMoveRefused']));
      const b = refusedAfterRestart(`SRF${i}`, false);
      expect(b.w.verdict().failures).toEqual(expect.arrayContaining(['legalMoveRefused']));
    }));

  it('the seat-taken notice stops the ledger of the hand on show, whichever record was made last', () =>
    scenario((i) => {
      const w = wire({ code: `SRK${i}`, rules: NORMAL, botDelayMs: 700 });
      need(w.toDiscard(3));
      w.restart((saved) => {
        saved.plays.push({ hand: 9001, seen: [], sent: [], ledgerFrom: 2 } as never);
        return saved;
      });
      need(w.until(() => typeof plays(w.c).find((p) => p.hand === 0)?.ledgerFrom === 'number' && Number.isFinite(plays(w.c).find((p) => p.hand === 0)!.ledgerFrom as number)));
      w.line.inject({ t: 'disconnected' } as HostMessage);
      expect(plays(w.c).find((p) => p.hand === 0)?.ledgerFrom).toBe(Number.POSITIVE_INFINITY);
    }));
});

/**
 * Normal, two rotations. Between hand 0 and hand 1 the server moves 300 points from the seat to seat 1 in the scores
 * hand 1 starts from, and deals hand 1 from them; once hand 1's first state has reached the phone it sends `flood`
 * malformed commitment sets, each for a hand never dealt (5001, 5002, ...). Each was once flagged against the hand it
 * named, and the twelfth pushed hand 1's flags, the scores' among them, out of the twelve hands' flags the phone keeps.
 */
function movedScores(code: string, flood: number) {
  let patched = false;
  let flooded = false;
  const w = wire({
    code,
    rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
    botDelayMs: 700,
    intermissionSeconds: 5,
    think: () => 1_000,
    onTick: (w) => {
      const snap = (w.host as unknown as { snapshot: { handNumber: number; matchOver: boolean; scores: number[] } }).snapshot;
      if (!patched && snap.handNumber === 1 && !snap.matchOver) {
        patched = true;
        snap.scores = snap.scores.slice();
        snap.scores[0] -= 300;
        snap.scores[1] += 300;
      }
      const v = w.c.state.view;
      if (patched && !flooded && v && v.handNumber === 1 && w.c.state.lastResult === null) {
        flooded = true;
        for (let j = 1; j <= flood; j++) w.line.inject({ t: 'commits', handNumber: 5000 + j, commits: [] } as unknown as HostMessage);
      }
    },
  });
  for (let k = 0; k < 20_000 && !w.c.state.matchOver; k++) w.step();
  return { w, patched, flooded, second: w.c.state.audits.find((a) => a.audit.handNumber === 1) };
}

describe('frames about the deal of a hand the phone is not on', () => {
  it('Normal, the scores moved between hands, then twelve malformed commitment sets for hands never dealt: the hand fails for the scores and for the malformed sets; with none sent it fails for the scores', () =>
    scenario((i) => {
      const a = movedScores(`SCM${i}`, 12);
      need(a.patched && a.flooded && a.second !== undefined);
      expect(a.second!.status).toBe('failed');
      expect(a.second!.failures).toEqual(expect.arrayContaining(['Hand started with scores different from where the previous hand left them', 'Host published a malformed set of commitments']));
      const b = movedScores(`SCM${i}`, 0);
      need(b.second !== undefined);
      expect(b.second!.failures).toEqual(['Hand started with scores different from where the previous hand left them']);
    }));

  it('a well-formed commitment set, or a share the host made for this seat, for a hand other than the one being played fails the hand and takes the place of nothing; the same for the hand being played changes nothing', () =>
    scenario((i) => {
      const commits = (h: number) => ({ t: 'commits', handNumber: h, commits: [0, 1, 2, 3, 4].map((seat) => ({ seat, hash: 'ab'.repeat(32) })) }) as unknown as HostMessage;
      const run = (frame: HostMessage | null) => {
        let sent = false;
        const w = wire({
          code: `SCS${i}`,
          rules: NORMAL,
          botDelayMs: 700,
          onTick: (w) => {
            if (sent || !w.c.state.view || mine(w) < 2 || w.host.phase !== 'playing') return;
            sent = true;
            if (frame) w.line.inject(frame);
          },
        });
        w.finish();
        need(sent);
        return w.verdict();
      };
      expect(run(commits(7))).toMatchObject({ status: 'failed', failures: ['strayFrame'] });
      expect(run({ t: 'stand_in', handNumber: 7, attempt: 1 } as HostMessage)).toMatchObject({ status: 'failed', failures: ['strayFrame'] });
      expect(run({ t: 'stand_in', handNumber: 0, attempt: 1 } as HostMessage)).toEqual({ status: 'ok', failures: [], caveats: [] });
      expect(run(null)).toEqual({ status: 'ok', failures: [], caveats: [] });
    }));
});

const HYPER4 = withRules({ handsPerMatch: 4, turnSeconds: 4, timeBankSeconds: 0 });
/** Every audit the phone holds, as `hand: status [failure keys] [caveat keys]`. */
const audits = (w: Wire) =>
  w.c.state.audits.map((a) => ({ hand: a.audit.handNumber, status: a.status, failures: a.failures.map((f) => failureKeyOf(f)), caveats: a.caveats.map((c) => caveatKeyOf(c)) }));
const failureKeyOf = (f: string) => failureKey(f) ?? f;
const caveatKeyOf = (c: string) => caveatKey(c) ?? c;
const STRAY = ['strayFrame', 'restartMidLink', 'restartedTwice'];

/**
 * The honest orders a returning or restarted table sends (`TableHost.onJoin`): the welcome, the records of the hands
 * that ended while the link was down, the restart notice, a stand-in notice, then the state, the hand's result or the
 * deal in progress. A server restart drops every link; the restored table names the hand it resumed, with its turn,
 * or the next hand at -1 when it was between hands, on each rejoin until that hand ends.
 */
describe('honest returns and restarts keep their verdicts', () => {
  /**
   * Hyper, four rotations. After the seat's second move its link goes dead both ways without the table noticing (the
   * phone's own watch is off), so the table plays on, timing the seat out. Once the table has reached hand `back` the
   * phone joins again on a new link and takes the seat back (`restartIn`: the server restarts first, which drops every
   * link, and the phone joins the restored table 2 s later).
   */
  function away(code: string, back: number, restartIn: boolean) {
    let dead = false;
    let started = false;
    let returned = false;
    const w = wire({
      code,
      rules: HYPER4,
      botDelayMs: 300,
      intermissionSeconds: 3,
      watch: false,
      map: (m) => (dead ? null : m),
      upFilter: () => !dead,
      onTick: (w) => {
        const g = w.host.game;
        if (!started && g && g.handNumber === 0 && w.host.phase === 'playing' && !w.owes() && mine(w) >= 2) {
          started = true;
          dead = true;
        }
        if (started && !returned && g && g.handNumber >= back && w.host.phase === 'playing' && g.turnCounter > 6) {
          returned = true;
          dead = false;
          if (restartIn) w.restartHost(2_000);
          else w.reconnect();
        }
      },
    });
    for (let k = 0; k < 40_000 && !w.c.state.matchOver; k++) w.step();
    return { w, returned };
  }

  it('Hyper, the link dead for two hands without the table noticing, the phone back in the third: the hands it missed are amber (it was away), none red, and a later hand green; the same with the server restarted in the third hand just before the phone is back', () =>
    scenario((i) => {
      for (const restartIn of [false, true]) {
        const t = away(`SHA${restartIn ? 'r' : ''}${i}`, 2, restartIn);
        need(t.returned && t.w.c.state.matchOver);
        const all = audits(t.w);
        need(all.some((a) => a.hand >= 3));
        expect(all.filter((a) => a.status === 'failed')).toEqual([]);
        for (const a of all) expect(a.failures.filter((f) => STRAY.includes(f))).toEqual([]);
        expect(all.filter((a) => a.hand < 2).every((a) => a.status === 'partial' && a.caveats.includes('away'))).toBe(true);
        expect(all.find((a) => a.hand === 3)?.status).toBe('ok');
      }
    }));

  /**
   * Normal, two rotations, the server restarted once (`at`): `mid` while the seat owes nothing in hand 0, `between` while
   * hand 0's result is shown, `deal` while hand 1's deal is being agreed. The phone joins again 1 s later.
   */
  function restartAt(code: string, at: 'mid' | 'between' | 'deal') {
    let done = false;
    const w = wire({
      code,
      rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
      botDelayMs: 700,
      intermissionSeconds: 5,
      onTick: (w) => {
        if (done) return;
        const g = w.host.game;
        const phase = w.host.phase;
        const go =
          at === 'mid' ? phase === 'playing' && g?.handNumber === 0 && !w.owes() && mine(w) >= 3 && w.c.state.view?.turnCounter === g.turnCounter
          : at === 'between' ? phase === 'hand_over' && w.c.state.lastResult !== null
          : (phase === 'commit' || phase === 'reveal') && (w.host as unknown as { snapshot: { handNumber: number } }).snapshot.handNumber === 1;
        if (!go) return;
        done = true;
        w.restartHost(1_000);
      },
    });
    for (let k = 0; k < 20_000 && !w.c.state.matchOver; k++) w.step();
    return { w, done };
  }

  it('Normal, the server restarted mid-hand with the seat owing nothing, and while a hand’s result was shown: every hand green', () =>
    scenario((i) => {
      for (const at of ['mid', 'between'] as const) {
        const t = restartAt(`SHR${at}${i}`, at);
        need(t.done && t.w.c.state.matchOver);
        const all = audits(t.w);
        need(all.length >= 2);
        expect(all.map((a) => [a.hand, a.status])).toEqual(all.map((a) => [a.hand, 'ok']));
      }
    }));

  it('Normal, the server restarted while the next deal was being agreed: that deal is run again, so its hand is amber (the deal was restarted), never red; every other hand green', () =>
    scenario((i) => {
      const t = restartAt(`SHD${i}`, 'deal');
      need(t.done && t.w.c.state.matchOver);
      const all = audits(t.w);
      const second = all.find((a) => a.hand === 1);
      need(second !== undefined);
      expect(second!.status).toBe('partial');
      expect(second!.failures).toEqual([]);
      expect(all.filter((a) => a.hand !== 1).every((a) => a.status === 'ok')).toBe(true);
    }));

  it('Normal, the seat’s commitment for the next deal lost on its way and the phone back on a new link while the table still waits for it: asked again, it commits on the new link; that hand amber (its link was lost during the deal), never red; the others green', () =>
    scenario((i) => {
      let lost = false;
      let back = false;
      const w = wire({
        code: `SHC${i}`,
        rules: withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 }),
        botDelayMs: 700,
        intermissionSeconds: 5,
        upFilter: (m, w) => {
          if (lost || m.t !== 'commit' || (w.host as unknown as { snapshot: { handNumber: number } }).snapshot.handNumber !== 1) return true;
          lost = true;
          return false;
        },
        onTick: (w) => {
          if (!lost || back || w.host.phase !== 'commit') return;
          back = true;
          // The old link is not closed: the table learns of the new one from the join, as when it has not seen the drop.
          w.reconnect();
        },
      });
      for (let k = 0; k < 20_000 && !w.c.state.matchOver; k++) w.step();
      need(back && w.c.state.matchOver);
      const all = audits(w);
      const second = all.find((a) => a.hand === 1);
      need(second !== undefined);
      expect(second!.failures).toEqual([]);
      expect(second!.status).toBe('partial');
      expect(all.filter((a) => a.hand !== 1).every((a) => a.status === 'ok')).toBe(true);
    }));
});

/**
 * Normal. From the seat's second move on, the server holds the state of each of its next three turns 10 s (every
 * other frame behind it waits too, its answers to pings aside; honest stamps) and, just before each held state,
 * announces a restart for a hand never dealt (1001, 1002, ...) on the link that never dropped (`notice`), or does not
 * (the control). Such a notice once began a new clock era each time, so no turn held under it was measured.
 */
function heldUnderNotices(code: string, notice: boolean) {
  let holdUntil: number | null = null;
  let heldNow: number | null = null;
  let j = 0;
  const held: number[] = [];
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => 1_000,
    map: (m, w) => {
      const g = w.host.game;
      const holding = holdUntil !== null && w.clock.now < holdUntil;
      if (m.t === 'pong' && holding) {
        w.line.inject(m);
        return null;
      }
      if (!holding && held.length < 3 && m.t === 'state' && g && w.owes() && g.turnCounter === m.view.turnCounter && typeof m.deadline === 'number' && !m.inTimeBank && typeof m.now === 'number' && m.deadline - m.now >= 14_000 && mine(w) >= 2) {
        held.push(m.view.turnCounter);
        heldNow = m.view.turnCounter;
        holdUntil = w.clock.now + 10_000 + (w.clock.now % 1_000 === 0 ? 300 : 0);
      }
      return m;
    },
    delay: (_m, now) => (holdUntil !== null && now < holdUntil ? holdUntil - now : 0),
    before: (m) => {
      if (!notice || m.t !== 'state' || m.view.turnCounter !== heldNow) return [];
      heldNow = null;
      return [{ t: 'restored', handNumber: 1000 + ++j, turnCounter: 0 } as HostMessage];
    },
  });
  w.finish();
  return { w, held };
}

describe('restart notices for a hand the phone is not on, or more than one in a hand', () => {
  it('Normal, three turns held 10 s, each under a restart notice for a hand never dealt, on a link that never dropped: red (the notices change nothing, and the turns stay late); without the notices amber lateShown', () =>
    scenario((i) => {
      const a = heldUnderNotices(`SRN${i}`, true);
      need(a.held.length >= 2);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(['restartMidLink']);
      expect(a.w.verdict().caveats).toContain('lateShown');
      const b = heldUnderNotices(`SRN${i}`, false);
      need(b.held.length >= 2);
      expect(b.w.verdict()).toMatchObject({ status: 'partial', failures: [] });
      expect(b.w.verdict().caveats).toContain('lateShown');
    }));

  it('Normal, the link dropped on two of the seat’s turns, each time with a restart notice for a hand never dealt as the new link’s first word: the first may begin a new clock era, the second, with the same hand on show, is a second restart: red', () =>
    scenario((i) => {
      let drops = 0;
      let lastTc = -1;
      const w = wire({
        code: `SRD${i}`,
        rules: NORMAL,
        botDelayMs: 700,
        think: () => 1_000,
        onTick: (w) => {
          const g = w.host.game;
          if (drops >= 2 || !g || w.host.phase !== 'playing' || w.pendingReconnectAt !== null || !w.current() || mine(w) < 2 || g.turnCounter === lastTc) return;
          lastTc = g.turnCounter;
          w.afterWelcome({ t: 'restored', handNumber: 1001 + drops, turnCounter: 0 } as HostMessage);
          drops++;
          w.dropNow(500);
        },
      });
      w.finish();
      need(drops === 2);
      expect(w.verdict().status).toBe('failed');
      expect(w.verdict().failures).toEqual(['restartedTwice']);
    }));

  it('Normal, a restart that took back a turn, announced as the new link’s first word, then four notices for hands never dealt on that link: red, and the restart that took back the turn is still named', () =>
    scenario((i) => {
      let notice: { hand: number; tc: number } | null = null;
      let extras = false;
      const w = wire({
        code: `SRU${i}`,
        rules: NORMAL,
        botDelayMs: 700,
        think: () => 1_000,
        onTick: (w) => {
          const g = w.host.game;
          if (notice || !g || w.host.phase !== 'playing' || w.owes()) return;
          const mineN = g.actionLog.filter((e) => e.seat === 0);
          const v = w.c.state.view;
          if (mineN.length < 3 || !v || v.turnCounter !== g.turnCounter || v.turnCounter < mineN[mineN.length - 1].n + 3) return;
          notice = { hand: g.handNumber, tc: v.turnCounter - 1 };
          w.afterWelcome({ t: 'restored', handNumber: notice.hand, turnCounter: notice.tc } as HostMessage);
          w.dropNow(1_000);
        },
        after: (m) => {
          if (!notice || extras || m.t !== 'state' || w.pendingReconnectAt !== null) return [];
          extras = true;
          return [1, 2, 3, 4].map((k) => ({ t: 'restored', handNumber: 1000 + k, turnCounter: 0 }) as HostMessage);
        },
      });
      w.finish();
      need(notice !== null && extras);
      expect(w.verdict().status).toBe('failed');
      expect(w.verdict().failures).toEqual(['restartMidLink']);
      expect(w.verdict().caveats).toContain('serverRestart');
    }));
});
