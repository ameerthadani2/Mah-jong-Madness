/**
 * A new match at the same table starts from a new match's start.
 *
 * After a match this device verified to its end, a welcome with a new match id starts a fresh record. An honest server runs
 * one match per table (one `TableHost`, one match id, for the room's life), so the new match is one the phone sits at from
 * its lobby: its first hand must be hand 0, from the rules' starting position (`atStart`). A server that deals it a later
 * hand first, or from other scores, fails that hand, and the new match's end is not shown as verified.
 */
import { describe, expect, it } from 'vitest';
import { matchSnapshot, newGame, withRules, type MatchSnapshot, type RuleSet } from '@mjm/engine';
import type { HostMessage, SeatInfo } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });

/**
 * One match played to its verified end; then, on the same link, the server sends a welcome with a new match id and deals
 * the new match from hand `start` with `shift` points moved from the seat to seat 1.
 */
function secondMatch(code: string, start: number, shift: number) {
  const w = wire({ code, rules: RULES, botDelayMs: 700, intermissionSeconds: 5, think: () => 1_000 });
  for (let k = 0; k < 20_000 && !w.c.state.matchOver; k++) w.step();
  const verifiedA = w.c.state.matchOver && w.c.state.matchEndVerified;
  const host = w.host as unknown as { rules: RuleSet; matchId: string; snapshot: MatchSnapshot; phase: string; game: unknown; deadline: unknown; ceremonyHand: number; audits: unknown[]; wins: number[]; roomCode: string; botSkill: string; seats: Array<{ token?: string }>; seatInfo(): SeatInfo[]; start(): void };
  const fresh = matchSnapshot(newGame('anchor', host.rules, 0));
  const scores = fresh.scores.slice();
  scores[0] -= shift;
  scores[1] += shift;
  host.matchId = `mB-${code}`;
  host.snapshot = { ...fresh, handNumber: start, scores, matchOver: false };
  host.phase = 'lobby';
  host.game = null;
  host.deadline = null;
  host.ceremonyHand = -1;
  host.audits.length = 0;
  host.wins = [0, 0, 0, 0];
  w.line.inject({ t: 'welcome', seat: 0, roomCode: host.roomCode, rules: host.rules, seats: host.seatInfo(), matchId: host.matchId, token: host.seats[0].token!, botSkill: host.botSkill, clockMs: 3_000 } as HostMessage);
  host.start();
  for (let k = 0; k < 20_000 && !(w.c.state.matchOver && w.c.state.matchId === host.matchId); k++) w.step();
  const first = w.c.state.audits.find((a) => a.audit.matchId === host.matchId && a.audit.handNumber === start);
  return { w, verifiedA, first, verifiedB: w.c.state.matchOver && w.c.state.matchEndVerified };
}

describe('a new match id after a verified end', () => {
  it('its first hand dealt as hand 5: red, dealt out of turn, and its end not verified (it was once green and verified)', () =>
    scenario((i) => {
      const a = secondMatch(`NMA${i}`, 5, 0);
      need(a.verifiedA && !!a.first);
      expect(a.first!.status).toBe('failed');
      expect(a.first!.failures).toContain('Host dealt a hand out of turn');
      expect(a.verifiedB).toBe(false);
    }));

  it('hand 5 with 600 points moved: red as well (it was once green and verified)', () =>
    scenario((i) => {
      const a = secondMatch(`NMB${i}`, 5, 600);
      need(a.verifiedA && !!a.first);
      expect(a.first!.status).toBe('failed');
      expect(a.verifiedB).toBe(false);
    }));

  it('controls: hand 0 with the points moved, red as it always was; an honest new match, green and verified', () =>
    scenario((i) => {
      const a = secondMatch(`NMC${i}`, 0, 600);
      need(a.verifiedA && !!a.first);
      expect(a.first!.status).toBe('failed');
      expect(a.first!.failures).toContain('The match started with scores different from a new match');
      const b = secondMatch(`NMD${i}`, 0, 0);
      need(b.verifiedA && !!b.first);
      expect(b.first!.status).toBe('ok');
      expect(b.verifiedB).toBe(true);
    }));
});
