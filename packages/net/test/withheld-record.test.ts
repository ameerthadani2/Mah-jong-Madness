/**
 * A hand's record is never lost in silence.
 *
 * When the table moves on past the hand this device was on while its link was down, the hand gets a verdict of its own,
 * listed with the audits: amber when the table sent no record it was asked for (a join that says nothing of the hands
 * the device holds is sent none), red when the device's join said which hands it held and the table welcomed it, yet
 * sent the later hand without the record: an honest host sends the record of every later hand that ended first
 * (`TableHost.sendMissed`). The next hand is amber, the scores it started from unchecked, as before.
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import type { SerializedClient } from '../src/index';
import { Missed, scenario, seededDeals } from './support';
import { wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });

/**
 * Normal, the seat at seat 0. Once hand 0 reaches turn 12 the link drops and stays down until hand 1 is under way (the
 * table plays the seat by its clock meanwhile); the phone then joins again. `skip`: the server leaves hand 0's record out
 * of what it sends the returning phone. `tokenOnly`: before the drop, the app restarted with its saved record damaged, so
 * it came back from its rejoin token alone and its join says nothing of the hands it holds.
 */
function awayPastHand(code: string, skip: boolean, tokenOnly: boolean) {
  let restarted = false;
  let cut = false;
  const w = wire({
    code,
    rules: RULES,
    botDelayMs: 700,
    intermissionSeconds: 5,
    fireClose: true,
    map: (m) => (skip && cut && m.t === 'hand_missed' && m.audit.handNumber === 0 ? null : m),
    onTick: (w) => {
      const g = w.host.game;
      if (tokenOnly && !restarted && g && g.handNumber === 0 && g.turnCounter >= 5 && w.host.phase === 'playing') {
        restarted = true;
        // A record storage damaged past reading: the app comes back from its rejoin token alone.
        w.restart((saved) => ({ ...saved, version: 0 }) as unknown as SerializedClient);
        return;
      }
      if (!cut && (!tokenOnly || restarted) && g && g.handNumber === 0 && g.turnCounter >= 12 && w.host.phase === 'playing' && w.c.state.view?.handNumber === 0) {
        cut = true;
        w.dropNow(3_600_000);
      }
      if (cut && w.pendingReconnectAt !== null && w.host.game && w.host.game.handNumber >= 1 && w.host.phase === 'playing' && w.host.game.turnCounter >= 2) w.pendingReconnectAt = w.clock.now;
    },
  });
  // Another player is at the table (not modelled): the table keeps its clocks and deals on while the phone is away.
  (w.host as unknown as { anyHumanConnected: () => boolean }).anyHumanConnected = () => true;
  for (let e = 0; e < 7_200_000 && !(w.c.state.audits.some((a) => a.audit.handNumber === 1) || w.c.state.matchOver); e += 500) w.step();
  const verdict = (h: number) => w.c.state.audits.find((a) => a.audit.handNumber === h);
  return { w, cut, h0: verdict(0), h1: verdict(1) };
}

describe('the hand the phone was on, when the table moves on without its record', () => {
  it('after a join that said which hands the phone held, the record left out: hand 0 red, listed among the audits (it once had no verdict at all); hand 1 amber, its start unchecked', () =>
    scenario((i) => {
      const a = awayPastHand(`WRA${i}`, true, false);
      need(a.cut && !!a.h1);
      expect(a.h0?.status).toBe('failed');
      expect(a.h0?.failures).toContain('Host moved on to a later hand without sending the record of this one, which this device asked for when it joined again');
      expect(a.h0?.audit.handNumber).toBe(0);
      expect(a.h1!.status).not.toBe('ok');
      expect(a.h1!.caveats.some((c) => c.startsWith('This device missed the hands before this one'))).toBe(true);
      expect(a.w.c.state.matchFailed).toBe(true);
    }));

  it('control: the record sent, hand 0 is checked as a hand played while the phone was away, amber', () =>
    scenario((i) => {
      const a = awayPastHand(`WRB${i}`, false, false);
      need(a.cut && !!a.h0 && !!a.h1);
      expect(a.h0!.status).toBe('partial');
      expect(a.h0!.caveats.some((c) => c.startsWith('This device was away when the hand ended'))).toBe(true);
    }));

  it('honest: a phone back from its token alone says nothing of the hands it holds and is sent no records: hand 0 amber with its own verdict, never silence', () =>
    scenario((i) => {
      const a = awayPastHand(`WRC${i}`, false, true);
      need(a.cut && !!a.h1);
      expect(a.h0?.status).toBe('partial');
      expect(a.h0?.caveats.some((c) => c.startsWith('This device was on this hand when its connection dropped'))).toBe(true);
      expect(a.h0?.failures).toEqual([]);
    }));
});
