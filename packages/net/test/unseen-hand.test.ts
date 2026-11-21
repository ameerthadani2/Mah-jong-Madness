/**
 * A hand dealt from this device's share is held to its ledger and its clock from the deal, whether or not the table
 * shows it to the phone.
 *
 * Once the phone has committed to a hand it holds the seat from before the deal, so every move the log credits to its
 * player in that hand, from turn 0, must be one it sent (`ledgerFrom` is 0 from the commit request). On a link that was
 * up before the deal, every state of the hand is owed there first: a hand whose first frame there is a later turn, or its
 * end, was held back, and a move the table made for the seat in it fails (`heldFrame`). A hand first shown on a later
 * link is judged as time without a link, and its first move for the seat needed a whole clock after the phone sent its
 * share (`MoveJudge.dealAfter`). And a deal's state held back while the table answers the phone's pings arrives behind
 * those answers, stamped later than it: held back, as any turn held that way is (`noteOrder`).
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules, type Action, type GameState } from '@mjm/engine';
import type { HostMessage } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const NORMAL = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const host = (w: Wire) => w.host as unknown as { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };
/** The hand a frame is about, if it names one. */
const handOf = (m: HostMessage): number | null => (m.t === 'state' ? m.view.handNumber : m.t === 'clock' ? m.hand : null);

/**
 * Hand 0 at Normal, over the link the phone sat down on. From the deal on, whenever the seat owes a move the server plays
 * one for it at once: `player`, a move of its own choosing written down as the player's; `timeout`, the move the timeout
 * rule gives, written down as the table's (with no clock run out). `withhold`: `all`, no state or clock frame of the hand
 * reaches the phone before its result; `first`, none until the server has played `first` such moves, then every frame
 * goes through and the seat plays on itself; `none`, every frame reaches the phone, which never moves (the control).
 */
function unseen(code: string, how: 'player' | 'timeout', withhold: 'all' | 'first' | 'none', first = 3) {
  let played = 0;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    think: () => (withhold === 'first' ? 1_000 : Infinity),
    map: (m) => (withhold === 'none' || (withhold === 'first' && played >= first) || handOf(m) !== 0 ? m : null),
    onTick: (w) => {
      const g = w.host.game;
      if (!g || w.host.phase !== 'playing' || g.handNumber !== 0 || (withhold === 'first' && played >= first)) return;
      if (legalActions(g, 0).length === 0) return;
      const a = how === 'timeout' ? host(w).timeoutAction(g, 0) : chooseAction(g, 0, { seed: 'server' });
      if (!a) return;
      host(w).apply(0, a, how === 'timeout' ? 'timeout' : 'player');
      played++;
    },
  });
  w.finish();
  const shown = [...w.shown.keys()].length;
  return { w, played, shown };
}

describe('a hand the phone was dealt into but not shown', () => {
  it('moves written down as the player’s, with no state of the hand ever shown: red, moves it never made (it was once green)', () =>
    scenario((i) => {
      const a = unseen(`UNP${i}`, 'player', 'all');
      need(a.played > 0);
      expect(a.shown).toBe(0);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['moveInvented'] });
    }));

  it('the timeout rule’s moves played at once, with no state shown: red, the table held back what it owed the link, then played for the seat (it was once green)', () =>
    scenario((i) => {
      const a = unseen(`UNT${i}`, 'timeout', 'all');
      need(a.played > 0);
      expect(a.shown).toBe(0);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['heldFrame'] });
    }));

  it('the first three moves played unseen, then the hand shown: red either way (the player’s were once green)', () =>
    scenario((i) => {
      const a = unseen(`UFP${i}`, 'player', 'first');
      need(a.played === 3);
      expect(a.w.verdict().status).toBe('failed');
      expect(a.w.verdict().failures).toEqual(expect.arrayContaining(['moveInvented']));
      const b = unseen(`UFT${i}`, 'timeout', 'first');
      need(b.played === 3);
      expect(b.w.verdict().status).toBe('failed');
      expect(b.w.verdict().failures).toEqual(expect.arrayContaining(['heldFrame']));
    }));

  it('controls: the same moves with every frame shown fail as they always did', () =>
    scenario((i) => {
      const a = unseen(`UNC${i}`, 'player', 'none');
      need(a.played > 0);
      expect(a.w.verdict()).toMatchObject({ status: 'failed', failures: ['moveInvented'] });
      const b = unseen(`UNC${i}`, 'timeout', 'none');
      need(b.played > 0);
      expect(b.w.verdict()).toMatchObject({ status: 'failed', failures: ['playedEarly'] });
    }));
});

/**
 * Hand 0 at Normal. Right after the phone has revealed its share and the host has dealt, before the deal's state reaches
 * it, its link drops; it joins again `away` ms later. `forge`: meanwhile the server plays the timeout rule's move for the
 * seat at once whenever it owes one (as the table's), or `player`, a move of its choosing as the player's own. Without it
 * the table plays the seat by its clock, as an honest one does.
 */
function cutAfterReveal(code: string, away: number, forge: 'timeout' | 'player' | null) {
  let dealt = false;
  let cut = false;
  let played = 0;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    fireClose: true,
    // The deal's frames are lost with the link (it drops at the next tick).
    map: (m) => {
      if (cut || handOf(m) !== 0) return m;
      dealt = true;
      return null;
    },
    onTick: (w) => {
      const g = w.host.game;
      if (dealt && !cut) {
        cut = true;
        w.dropNow(away);
      }
      if (!forge || !cut || w.pendingReconnectAt === null || !g || w.host.phase !== 'playing' || g.handNumber !== 0) return;
      if (legalActions(g, 0).length === 0) return;
      const a = forge === 'timeout' ? host(w).timeoutAction(g, 0) : chooseAction(g, 0, { seed: 'server' });
      if (!a) return;
      host(w).apply(0, a, forge === 'timeout' ? 'timeout' : 'player');
      played++;
    },
  });
  w.finish();
  const audit = w.c.state.audits.find((a) => a.audit.handNumber === 0);
  return { w, played, cut, audit };
}

describe('a hand first shown on a later link', () => {
  it('the timeout rule’s moves played at once while the link was down after the reveal: red, the table could not have timed the seat out so soon after its share went out (it was once amber)', () =>
    scenario((i) => {
      const a = cutAfterReveal(`UCT${i}`, 3_000, 'timeout');
      need(a.cut && a.played > 0 && !!a.audit);
      expect(a.audit!.status).toBe('failed');
      expect(a.audit!.failures.map((f) => f.replace(/ \(turn .*\)$/, ''))).toContain('The table played for this seat while its connection was down, before its clock could have run out');
    }));

  it('moves written down as the player’s while the link was down after the reveal: red, moves it never made', () =>
    scenario((i) => {
      const a = cutAfterReveal(`UCP${i}`, 3_000, 'player');
      need(a.cut && a.played > 0 && !!a.audit);
      expect(a.audit!.status).toBe('failed');
      expect(a.audit!.failures.some((f) => f.startsWith('The log shows a move this seat never made'))).toBe(true);
    }));

  it('honest: the table plays the seat by its clock while the link is down for a minute, and the hand stays amber', () =>
    scenario((i) => {
      const a = cutAfterReveal(`UCH${i}`, 60_000, null);
      need(a.cut && !!a.audit && a.audit.audit.log.some((e) => e.seat === 0 && e.source !== 'player'));
      expect(a.audit!.status).toBe('partial');
      expect(a.audit!.failures).toEqual([]);
    }));
});

/**
 * Hand `hand` at Normal: hand 1 over the link that brought hand 0, or hand 0 over the link the phone sat down on (which has
 * brought no state before it). From the deal on, the server holds back every state and clock frame of the hand for
 * `hold` ms (answering the phone's pings all the while), then lets them go as the host stamped them; the seat plays on
 * when it sees its turn.
 */
function heldDeal(code: string, hold: number, hand = 1) {
  let since: number | null = null;
  let released = false;
  /** The last turn of hand 1 the server held. */
  let heldTo = -1;
  const w = wire({
    code,
    rules: NORMAL,
    botDelayMs: 700,
    intermissionSeconds: 5,
    hold: (m, w) => {
      if (released || handOf(m) !== hand) return false;
      if (since === null) since = w.clock.now;
      if (m.t === 'state') heldTo = Math.max(heldTo, m.view.turnCounter);
      return true;
    },
    onTick: (w) => {
      if (since === null || released || w.clock.now - since < hold) return;
      released = true;
      w.line.release();
    },
  });
  for (let e = 0; e < 3_600_000 && !(w.c.state.audits.some((a) => a.audit.handNumber === hand) || w.c.state.matchOver); e += 500) w.step();
  const audit = w.c.state.audits.find((a) => a.audit.handNumber === hand);
  // The seat was shown one of its moves in what the server held (the first state of that move is among the held ones).
  const firstOwn = audit?.audit.log.find((e) => e.seat === 0)?.n ?? Number.POSITIVE_INFINITY;
  return { w, released, audit, ownInHeld: firstOwn <= heldTo };
}

describe('the deal’s state held back while the table answers the pings', () => {
  it('held 25 s after the reveal and then let go as stamped: red where the seat’s turn was in it, the state having come behind the answers to the pings (it was once amber)', () =>
    scenario((i) => {
      const a = heldDeal(`UHD${i}`, 25_000);
      need(a.released && !!a.audit && a.ownInHeld);
      expect(a.audit!.status).toBe('failed');
      expect(a.audit!.failures.some((f) => f.startsWith('The host showed this seat its turn late, on a link that stayed open') || f.startsWith('The host held back its frames on a link that stayed open'))).toBe(true);
    }));

  it('the same with hand 0, on the link the phone sat down on, which had brought no state before the deal: red too (it was once amber)', () =>
    scenario((i) => {
      const a = heldDeal(`UHZ${i}`, 25_000, 0);
      need(a.released && !!a.audit && a.ownInHeld);
      expect(a.audit!.status).toBe('failed');
      expect(a.audit!.failures.some((f) => f.startsWith('The host showed this seat its turn late, on a link that stayed open') || f.startsWith('The host held back its frames on a link that stayed open'))).toBe(true);
    }));

  it('control: held 2 s, within what a slow deal takes: the hand stays green', () =>
    scenario((i) => {
      const a = heldDeal(`UHC${i}`, 2_000);
      need(a.released && !!a.audit);
      expect(a.audit!.status).toBe('ok');
    }));
});
