/**
 * Boundaries a server can bring about do not turn the phone's measures off.
 *
 * A link the table never welcomes is measured as any other: while the phone holds a seat on a link that is up it
 * pings the table once a second and watches the link, whether or not a `welcome` came (an honest host welcomes a
 * link before it sends anything else on it).
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import type { TableClient } from '../src/index';
import type { PlayRecord } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire, type Wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const plays = (c: TableClient) => (c as unknown as { plays: PlayRecord[] }).plays;
const HYPER2 = withRules({ handsPerMatch: 2, turnSeconds: 4, timeBankSeconds: 0 });

/**
 * Hyper, two hands. The server drops the phone's link once in the first hand (3 s into the seat's first turn, as a
 * lost connection does), lets it back on a new link and sends it every frame but the `welcome` (`welcome` true: the
 * control, the welcome sent). From the second hand on it holds the state of each of the seat's turns `hold` ms (every
 * frame behind it waits too; honest stamps). The phone sends the ping the app sends right behind each join; the seat
 * moves `think` ms after it is shown its move.
 */
function neverWelcomed(code: string, welcome: boolean, hold: number, think: number) {
  let welcomes = 0;
  let dropped = false;
  let firstOwed: number | null = null;
  /** The wire, once made (the host sends frames while it is made). */
  let made: Wire | null = null;
  const w = wire({
    code,
    rules: HYPER2,
    botDelayMs: 700,
    fireClose: true,
    think: () => think,
    onReconnect: (w) => w.c.ping(),
    map: (m) => (m.t === 'welcome' && welcomes++ > 0 && !welcome ? null : m),
    delay: (m) => {
      const g = made?.host.game;
      if (!made || !g || g.handNumber < 1) return 0;
      return m.t === 'state' && made.owes() && g.turnCounter === m.view.turnCounter && m.view.handNumber === g.handNumber ? hold : 0;
    },
    onTick: (w) => {
      const g = w.host.game;
      if (dropped || !g || g.handNumber !== 0 || !w.owes() || w.host.phase !== 'playing') return;
      firstOwed ??= w.clock.now;
      if (w.clock.now >= firstOwed + 3_000) {
        dropped = true;
        w.dropNow(1_000);
      }
    },
  });
  made = w;
  for (let k = 0; k < 14_400 && !w.c.state.matchOver; k++) w.step();
  const second = w.c.state.audits.find((a) => a.audit.handNumber === 1);
  const taken = (second?.audit.log ?? []).filter((e) => e.seat === 0 && e.source !== 'player').length;
  // The pings the phone sent while the second hand was on show.
  const pings = plays(w.c).find((p) => p.hand === 1)?.pinged ?? 0;
  return { w, dropped, welcomes, pings, second, taken };
}

describe('a link the table never welcomes is measured as any other', () => {
  it('Hyper, the second hand’s turns held 3 s on a link the table never welcomed: the phone keeps pinging, and the hand is amber with the table’s moves on the held turns taken as late, never green; the same with the welcome sent', () =>
    scenario((i) => {
      const t = neverWelcomed(`NW${i}`, false, 3_000, 1_500);
      need(t.dropped && t.welcomes >= 2 && t.second !== undefined && t.taken > 0);
      expect(t.w.c.state.connected).toBe(false);
      expect(t.pings).toBeGreaterThan(5);
      expect(t.second!.status).toBe('partial');
      expect(t.second!.failures).toEqual([]);
      expect(t.second!.caveats).toContain('The table played for this seat on a turn that reached this device late, so it did not see that turn in time');
      const ctl = neverWelcomed(`NW${i}`, true, 3_000, 1_500);
      need(ctl.second !== undefined && ctl.taken > 0);
      expect(ctl.w.c.state.connected).toBe(true);
      expect(ctl.second!.status).toBe('partial');
    }));
});
