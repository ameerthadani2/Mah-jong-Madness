/**
 * A hand the table stood in for.
 *
 * A seat whose link is down at a hand's commit request is dealt in with a share the table makes (`stand_in`). When the
 * phone is seated again and told so, it holds the hand's log from the deal on, as after a commit request: an honest host
 * takes a move as the player's own only from the link it seats this phone on, and while the seat had no link nobody could
 * send one. (Only where the phone knows every move it sent in the hand: the hand began in this run of the app while it
 * held the seat, or the app's journal vouched for the record; and not while the server says another device held the seat.)
 * Before, the moves before the first state the phone was shown were not held to anything: a server that cut the link at
 * the commit request could play them in the player's name, its own choice of move, and the hand was amber.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules, type Action } from '@mjm/engine';
import { caveatKey, failureKey, type SerializedClient } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const RULES = withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 });
const host = (w: Wire) => w.host as unknown as { apply(seat: number, a: Action, source: string): void };
/** The verdict on hand `h`. */
const verdictOf = (w: Wire, h: number) => {
  const a = w.c.state.audits.find((x) => x.audit.handNumber === h);
  return a ? { status: a.status, failures: [...new Set(a.failures.map(failureKey))], caveats: a.caveats.map(caveatKey) } : null;
};
/** The seat's moves the log of hand `h` credits to its player. */
const playerMoves = (w: Wire, h: number) => (w.host as unknown as { audits: Array<{ handNumber: number; log: Array<{ seat: number; source: string }> }> }).audits.find((a) => a.handNumber === h)?.log.filter((e) => e.seat === 0 && e.source === 'player').length ?? 0;

type StandIn = 'forge' | 'silent' | 'timeout';

/**
 * Normal, two hands. Right after hand 0's result reaches the phone its link is cut, and the phone's next link comes 12 s
 * later: after hand 1 was dealt with a share the table made for the seat. On it the table seats the phone again and says
 * it stood in (`stand_in`), then:
 *   forge   : shows the table as it stands (the state right behind the welcome), but while the link was down it played the
 *             seat's moves itself, written as the player's own (its own choice of move);
 *   silent  : the same moves, and every state and clock frame of hand 1 withheld on the new link;
 *   timeout : nothing forged (the table moves for the seat only when its clock runs out): control.
 */
function standIn(code: string, mode: StandIn) {
  let cutAt: number | null = null;
  let back = false;
  let forged = 0;
  const w = wire({
    code,
    rules: RULES,
    botDelayMs: 700,
    think: () => 1_000,
    intermissionSeconds: 5,
    reconnectMs: 12_000,
    map: (m) => {
      if (mode !== 'silent' || !back) return m;
      const h = m.t === 'state' ? m.view.handNumber : m.t === 'clock' ? m.hand : null;
      return h === 1 ? null : m;
    },
    onReconnect: () => {
      back = true;
    },
    onTick: (w) => {
      if (cutAt === null && w.c.state.audits.some((a) => a.audit.handNumber === 0)) {
        cutAt = w.clock.now;
        w.dropNow(12_000);
        return;
      }
      const g = w.host.game;
      if (mode === 'timeout' || cutAt === null || !g || w.host.phase !== 'playing' || g.handNumber !== 1) return;
      // While the link is down (and, when silent, after it too), the table plays the seat's moves in the player's name.
      if (back && mode !== 'silent') return;
      if (legalActions(g, 0).length === 0) return;
      const a = chooseAction(g, 0, { seed: 'server-own-choice' });
      if (!a) return;
      host(w).apply(0, a, 'player');
      forged++;
    },
  });
  // The table plays on while nobody human is connected (as the server's does once a hand is dealt).
  (w.host as unknown as { anyHumanConnected(): boolean }).anyHumanConnected = () => true;
  for (let k = 0; k < 40_000 && !w.c.state.matchOver; k++) w.step();
  const stoodIn = w.c.state.audits.find((a) => a.audit.handNumber === 1)?.caveats.map(caveatKey).includes('standIn') ?? false;
  return { w, forged, stoodIn, back, player: playerMoves(w, 1) };
}

describe('a hand the table stood in for, the phone seated again', () => {
  it('the moves before the first state shown, written in the player’s name while the link was down: red (a move the seat never made; it was amber)', () =>
    scenario((i) => {
      const r = standIn(`SIF${i}`, 'forge');
      need(r.back && r.forged > 0);
      expect(verdictOf(r.w, 1)?.status).toBe('failed');
      expect(verdictOf(r.w, 1)?.failures).toEqual(expect.arrayContaining(['moveInvented']));
    }));

  it('the same moves with hand 1 kept silent on the new link: red', () =>
    scenario((i) => {
      const r = standIn(`SIS${i}`, 'silent');
      need(r.back && r.forged > 0);
      expect(verdictOf(r.w, 1)?.status).toBe('failed');
    }));

  it('control: nothing written for the seat while it was away: not red (the stand-in and the lost link make it amber)', () =>
    scenario((i) => {
      const r = standIn(`SIT${i}`, 'timeout');
      need(r.back && r.stoodIn);
      expect(verdictOf(r.w, 1)?.status).toBe('partial');
      expect(verdictOf(r.w, 1)?.failures).toEqual([]);
    }));

  it('honest: an app restarted from a record written before it was seated again in the stood-in hand holds the hand only from the state it is then shown (its earlier run may have moved there unrecorded)', () =>
    scenario((i) => {
      let cutAt: number | null = null;
      let prev: SerializedClient | null = null;
      let restarted = false;
      const w = wire({
        code: `SIR${i}`,
        rules: RULES,
        botDelayMs: 700,
        think: () => 1_000,
        intermissionSeconds: 5,
        reconnectMs: 12_000,
        onTick: (w) => {
          if (cutAt === null && w.c.state.audits.some((a) => a.audit.handNumber === 0)) {
            cutAt = w.clock.now;
            w.dropNow(12_000);
            return;
          }
          // The record as the app last wrote it: while the link was down, before hand 1 was shown.
          if (cutAt !== null && w.pendingReconnectAt !== null) prev = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
          // Back at the table, the seat moves in hand 1; then the app stops and restarts from that older record.
          const g = w.host.game;
          if (!restarted && prev && w.pendingReconnectAt === null && g?.handNumber === 1 && g.actionLog.some((e) => e.seat === 0 && e.source === 'player')) {
            restarted = true;
            w.restart(undefined, prev);
          }
        },
      });
      (w.host as unknown as { anyHumanConnected(): boolean }).anyHumanConnected = () => true;
      for (let k = 0; k < 40_000 && !w.c.state.matchOver; k++) w.step();
      // (The live seat moves in hand 1 before the restart: it played what its phone showed it.)
      const hand1 = (w.host as unknown as { audits: Array<{ handNumber: number }> }).audits.some((a) => a.handNumber === 1);
      need(restarted && hand1 && w.c.state.audits.some((a) => a.audit.handNumber === 1 && a.caveats.map(caveatKey).includes('standIn')));
      expect(verdictOf(w, 1)?.failures).toEqual([]);
    }));
});
