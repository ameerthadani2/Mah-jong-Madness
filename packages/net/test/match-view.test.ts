/**
 * The view on show at the end of a match. Every view this device was shown is held to the replay of its hand; the view a
 * `match_over` frame carries is checked by nothing (only the frame's scores are). So the last view this device holds stays
 * on show at the end, whatever hand number the frame's own view names, and the host's view goes on show only on a device
 * that holds none (one that came to the table at its end).
 */
import { describe, expect, it } from 'vitest';
import { TableClient, transportLink, type HostMessage } from '../src/index';
import { scenario, seededDeals } from './support';
import { wire } from './wire';

seededDeals();

type MatchOver = Extract<HostMessage, { t: 'match_over' }>;

/** A match played to its end; the server sends `match_over` with its view altered (`other`: under the next hand's number). */
function endWith(code: string, alter: 'other' | 'same' | 'none') {
  let fake: string | null = null;
  const w = wire({
    code,
    botDelayMs: 500,
    think: () => 700,
    map: (m) => {
      if (m.t !== 'match_over' || alter === 'none') return m;
      const c = JSON.parse(JSON.stringify(m)) as MatchOver;
      if (alter === 'other') c.view.handNumber += 1;
      // A table the replay never reached: every pond and the seat's own hand emptied (its count with it: a view whose
      // hand and count disagree is malformed, and not taken at all).
      for (const p of c.view.players) {
        p.discards = [];
        if (p.hand) {
          p.hand = [];
          p.handCount = 0;
        }
      }
      fake = JSON.stringify(c.view);
      return c;
    },
  });
  let before: string | null = null;
  for (let k = 0; k < 20_000 && !w.c.state.matchOver; k++) {
    if (w.c.state.lastResult) before = JSON.stringify(w.c.state.view);
    w.step();
  }
  return { w, fake, before, shown: JSON.stringify(w.c.state.view) };
}

describe('the view on show at the end of the match', () => {
  it("a match_over whose view names another hand: the last hand's view stays on show (it once took the host's place)", () =>
    scenario((i) => {
      const r = endWith(`MVO${i}`, 'other');
      expect(r.w.c.state.matchOver).toBe(true);
      expect(r.fake).not.toBeNull();
      expect(r.shown).not.toBe(r.fake);
      expect(r.shown).toBe(r.before);
      expect(r.w.c.state.matchEndVerified).toBe(true);
    }));

  it('controls: the same change under the last hand\'s number, and the frame as sent, leave the view on show as it was', () =>
    scenario((i) => {
      for (const alter of ['same', 'none'] as const) {
        const r = endWith(`MV${alter}${i}`, alter);
        expect(r.w.c.state.matchOver).toBe(true);
        expect(r.shown).toBe(r.before);
        if (r.fake) expect(r.shown).not.toBe(r.fake);
        expect(r.w.c.state.matchEndVerified).toBe(true);
      }
    }));

  it("a device that holds no view, back at the table at its end, shows the host's view (and the end is not verified)", () =>
    scenario((i) => {
      const r = endWith(`MVN${i}`, 'none');
      expect(r.w.c.state.matchOver).toBe(true);
      const token = (r.w.host as unknown as { seats: Array<{ token?: string }> }).seats[0].token;
      const late = new TableClient(transportLink(r.w.hub.create('late-device'), 'host'), 'Victim', undefined, { token });
      late.join();
      expect(late.state.matchOver).toBe(true);
      expect(late.state.view).not.toBeNull();
      expect(late.state.view!.handNumber).toBe(r.w.c.state.view!.handNumber);
      expect(late.state.matchEndVerified).toBe(false);
    }));
});
