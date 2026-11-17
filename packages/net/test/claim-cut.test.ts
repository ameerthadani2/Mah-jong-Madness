/**
 * A server can cut a player's link whenever that player could Pong, Chow or Kong, keep it out
 * until the claim window closes, and let the timeout rule pass the claim. Each such pass is a move
 * the rule allows for a seat that is away, so the hand cannot fail; but the phone names the claim
 * that was passed (`passedPong`, `passedChow`, `passedKong`) instead of only saying that the table
 * played while the link was down, and counts every one over the match (`claimsPassedAway`), so a
 * player can see the pattern: an honest drop costs a claim now and then, this attack every time.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, withRules, type GameState } from '@mjm/engine';
import { AUDIT_CAVEATS, LoopbackHub, TableClient, TableHost, transportLink, type Link } from '../src/index';
import { Missed, scenario, seededDeals } from './support';

seededDeals(20261117);

const deal = (name: string, fn: () => void) => it(name, () => scenario(fn));
const RULES = withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 });
const NAMED = [AUDIT_CAVEATS.passedPong, AUDIT_CAVEATS.passedChow, AUDIT_CAVEATS.passedKong] as string[];

function table(code: string) {
  const clock = { now: 1_000_000 };
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: RULES, now: () => clock.now, matchId: `m-${code}`, botSkill: 'club', intermissionSeconds: 5 });
  const h = host as unknown as { game: GameState | null; phase: string };
  let links = 0;
  const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Victim', undefined, {}, { now: () => clock.now });
  c.join();
  host.start();
  const t = {
    clock,
    host,
    c,
    cuts: 0,
    wait(ms: number) {
      for (let left = ms; left > 0; left -= 500) {
        clock.now += Math.min(500, left);
        host.tick();
      }
    },
    /** The attack: on every claim this seat could make (other than a win), the link drops for 50 s. */
    cutAtClaim(): boolean {
      if (host.phase !== 'playing' || h.game?.phase !== 'claim') return false;
      const offered = legalActions(h.game, 0);
      if (!offered.some((a) => a.type === 'pong' || a.type === 'chi' || a.type === 'kong') || offered.some((a) => a.type === 'hu')) return false;
      t.cuts++;
      (c as unknown as { link: Link }).link.close();
      t.wait(50_000);
      c.rebind(transportLink(hub.create(`p0-back${links++}`), 'host'));
      c.join();
      return true;
    },
    play(attack: boolean) {
      for (let g = 0; g < 8000 && host.phase === 'playing'; g++) {
        if (attack && t.cutAtClaim()) continue;
        const s = c.localState();
        if (s && legalActions(s, 0).length > 0) c.act(chooseAction(s, 0)!);
        else t.wait(60_000);
      }
      for (let g = 0; g < 100 && c.state.audits.length === 0; g++) t.wait(1000);
    },
  };
  return t;
}

describe('a claim the table passed for this seat while its link was down', () => {
  deal('is named in the hand and counted over the match, and the hand stays amber', () => {
    const t = table('CC1');
    t.play(true);
    if (t.cuts === 0) throw new Missed();
    expect(t.c.state.auditFailures).toEqual([]);
    expect(t.c.state.auditStatus).toBe('partial');
    expect(t.c.state.auditCaveats).toContain(AUDIT_CAVEATS.tableMoved);
    // Every cut cost a claim, and each one is in the match's record with its hand and turn.
    expect(t.c.state.claimsPassedAway.length).toBe(t.cuts);
    expect(t.c.state.claimsPassedAway.every((p) => p.hand === 0 && Number.isInteger(p.turn))).toBe(true);
    const kinds = new Set(t.c.state.claimsPassedAway.map((p) => p.claim));
    const named = t.c.state.auditCaveats.filter((x) => NAMED.includes(x));
    expect(named.length).toBe(kinds.size);
    if (kinds.has('pong')) expect(named).toContain(AUDIT_CAVEATS.passedPong);
    if (kinds.has('kong')) expect(named).toContain(AUDIT_CAVEATS.passedKong);
    if (kinds.has('chow')) expect(named).toContain(AUDIT_CAVEATS.passedChow);
  });

  deal('an honest table with a link that never drops names and counts nothing', () => {
    const t = table('CC2');
    t.play(false);
    expect(t.c.state.auditStatus).toBe('ok');
    expect(t.c.state.claimsPassedAway).toEqual([]);
    expect(t.c.state.auditCaveats.filter((x) => NAMED.includes(x))).toEqual([]);
  });

  deal('the count survives an app restart', () => {
    const t = table('CC3');
    t.play(true);
    if (t.cuts === 0) throw new Missed();
    const counted = t.c.state.claimsPassedAway;
    expect(counted.length).toBe(t.cuts);
    const saved = JSON.parse(JSON.stringify(t.c.serialize()));
    const back = TableClient.restore(saved, transportLink(new LoopbackHub().create('elsewhere'), 'host'), 'Victim', undefined, { token: saved.state.token }, { now: () => t.clock.now });
    expect(back.state.claimsPassedAway).toEqual(counted);
    // A saved record from before the count was kept restores with none.
    delete saved.state.claimsPassedAway;
    const old = TableClient.restore(saved, transportLink(new LoopbackHub().create('older'), 'host'), 'Victim', undefined, { token: saved.state.token }, { now: () => t.clock.now });
    expect(old.state.claimsPassedAway).toEqual([]);
  });
});
