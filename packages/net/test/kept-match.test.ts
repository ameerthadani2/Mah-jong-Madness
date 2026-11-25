/**
 * Records found by match (`TableClientOptions.keptRecord`). The app keeps the record of a table that left Home under its
 * game server and match. A client that holds no record of the match its first welcome names asks for one by that match:
 * so a server that seats the account again under another room code, or a join that went in with nothing, still finds the
 * phone holding what it checked. A record kept under another room than the one joined fails the hand it was on (an honest
 * server runs a match under one room code), and the red hands the app kept apart come back with or without a record.
 */
import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, sameAction, withRules, type Action, type GameState } from '@mjm/engine';
import { caveatKey, failureKey, LoopbackHub, TableClient, TableHost, transportLink, type KeptRecord, type Link, type SerializedClient } from '../src/index';
import { seededDeals } from './support';

// The same deals every run.
seededDeals();

const RULES = withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 });
const USER = 'u-victim';
type HostInside = { apply(seat: number, a: Action, source: string): void; timeoutAction(g: GameState, seat: number): Action };

/**
 * A table on a fake clock whose seat 0 is the player's phone; the server gives a verified account its own seat back.
 * `journal`: the phone keeps the app's journal of moves (`writeAhead`), every entry in this list.
 */
function table(code: string, journal: unknown[] | null = null) {
  let now = 7_000_000;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: code, rules: RULES, matchId: `m-${code}`, now: () => now, botDelayMs: 400, schedule: (fn, ms) => void timers.push({ at: now + ms, fn }), intermissionSeconds: 3, verifiedUserIds: true });
  let n = 0;
  const open = (): Link => transportLink(hub.create(`p${n++}`), 'host');
  let link = open();
  const t = {
    host,
    inside: host as unknown as HostInside,
    client: new TableClient(link, 'A', undefined, { userId: USER }, { now: () => now, monotonic: () => now, ...(journal ? { writeAhead: (e: unknown) => void journal.push(e) } : {}) }),
    playing: true,
    owed: new Map<string, number>(),
    step() {
      now += 100;
      for (const x of timers.filter((y) => y.at <= now)) {
        timers.splice(timers.indexOf(x), 1);
        x.fn();
      }
      host.tick();
      if (!t.playing) return;
      const st = t.client.state;
      if (st.lastResult && st.lastAudit && !st.matchOver && host.phase === 'hand_over') t.client.ready();
      const s = t.client.localState();
      if (!s || legalActions(s, 0).length === 0) return;
      const key = `${s.handNumber}:${s.turnCounter}`;
      const since = t.owed.get(key) ?? now;
      t.owed.set(key, since);
      if (since >= 0 && now - since >= 600) {
        t.owed.set(key, -1);
        t.client.act(chooseAction(s, 0)!);
      }
    },
    run(until: () => boolean, limit = 6000) {
      for (let i = 0; i < limit && !until(); i++) t.step();
    },
    owes: () => host.game !== null && host.phase === 'playing' && legalActions(host.game, 0).length > 0,
    /** The app goes: its link closes, and nothing of it runs. */
    away() {
      t.playing = false;
      link.close();
    },
    /** The account sits at the table again with a client that holds nothing (no token, no record), as the app makes it. */
    back(keptRecord?: (m: string) => KeptRecord | undefined, before?: (c: TableClient) => void) {
      t.backWith((l, o) => new TableClient(l, 'A', undefined, { userId: USER }, { ...o, ...(keptRecord ? { keptRecord } : {}) }), before);
    },
    /** The same with a client `make` builds on the new link, from the phone's clock and journal (`o`). */
    backWith(make: (l: Link, o: { now: () => number; monotonic: () => number; writeAhead?: (e: unknown) => void }) => TableClient, before?: (c: TableClient) => void) {
      link = open();
      t.client = make(link, { now: () => now, monotonic: () => now, ...(journal ? { writeAhead: (e: unknown) => void journal.push(e) } : {}) });
      t.playing = true;
      before?.(t.client);
      t.client.join();
    },
    /** A legal move of the seat that the table's own timeout rule would not make. */
    other(): Action | undefined {
      const g = host.game!;
      const timeout = t.inside.timeoutAction(g, 0);
      return legalActions(g, 0).find((a) => !sameAction(a, timeout, g, 0));
    },
  };
  t.client.join();
  host.start();
  return t;
}

const verdicts = (c: TableClient) => c.state.audits.map((a) => `${a.audit.handNumber}:${a.status}${a.failures.length ? ` ${a.failures.map((f) => failureKey(f) ?? f).join(',')}` : ''}`);

/**
 * The attack the sweep of unit 20f found (S3): the server writes a move in the player's name on a turn of hand 0, and once
 * the phone has been shown two more turns, its table leaves Home (the app keeps its record). Then it seats the account
 * again, here with a client that holds nothing, which is what the app makes when its lookup by room finds nothing (the
 * account is seated at another room code). `whileAway`: the move is written while the phone is away instead, and the
 * phone keeps the app's journal.
 */
function attack(code: string, keptRecord: ((rec: SerializedClient, journal: unknown[]) => (m: string) => KeptRecord | undefined) | null, whileAway = false) {
  const journal: unknown[] = [];
  const t = table(code, whileAway ? journal : null);
  let forged = false;
  let forgedAt = -1;
  const forge = () => {
    const a = t.other();
    if (!a) return;
    t.inside.apply(0, a, 'player');
    forged = true;
    forgedAt = t.host.game!.turnCounter;
  };
  t.run(() => t.host.game !== null && t.host.game.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length >= 2 && t.owes() && t.client.state.view?.turnCounter === t.host.game.turnCounter);
  if (!whileAway) {
    forge();
    t.run(() => (t.client.state.view?.turnCounter ?? -1) >= forgedAt + 2 && !t.owes());
  }
  const rec = JSON.parse(JSON.stringify(t.client.serialize())) as SerializedClient;
  t.away();
  if (whileAway) t.run(() => (t.owes() && forge(), forged), 2000);
  t.back(keptRecord ? keptRecord(rec, journal) : undefined);
  t.run(() => t.client.state.audits.some((a) => a.audit.handNumber === 0));
  return { t, forged, rec };
}

describe('a record kept of the match, found by the match the welcome names', () => {
  it('a client that joined with nothing takes up the record of the match: the move written in the player\'s name meanwhile fails the hand', () => {
    const { t, forged } = attack('KM1', (rec) => (m) => (m === rec.state.matchId ? { client: rec } : undefined));
    expect(forged).toBe(true);
    expect(verdicts(t.client)).toContainEqual(expect.stringMatching(/^0:failed .*moveInvented/));
    expect(t.client.state.matchFailed).toBe(true);
  });

  it('a move written in the player\'s name while the phone was away: amber with the welcome\'s word that another device held the seat (it joined as a new one), never green', () => {
    const { t, forged } = attack('KM4', (rec, journal) => (m) => (m === rec.state.matchId ? { client: rec, journal } : undefined), true);
    expect(forged).toBe(true);
    expect(t.client.state.audits.filter((a) => a.audit.handNumber === 0).map((a) => [a.status, a.caveats.map((c) => caveatKey(c))])).toEqual([['partial', ['otherDevice']]]);
    expect(t.client.state.matchEndVerified).toBe(false);
  });

  it('without it the client holds nothing, and the hand is amber at best (control)', () => {
    const { t, forged } = attack('KM1', null);
    expect(forged).toBe(true);
    expect(verdicts(t.client).filter((v) => v.startsWith('0:failed'))).toEqual([]);
  });

  it('a record the app kept under another room than the one joined: the hand it was on fails, and the match with it', () => {
    const { t } = attack('KM2', (rec) => (m) => (m === rec.state.matchId ? { client: rec, moved: true } : undefined));
    expect(verdicts(t.client)).toContainEqual(expect.stringMatching(/^0:failed .*matchRoomMoved/));
    expect(t.client.state.matchFailed).toBe(true);
    expect(t.client.state.matchEndVerified).toBe(false);
  });

  it('a record of another match, or of another seat, is not taken up; asked once, at the first welcome', () => {
    let asked = 0;
    const { t } = attack('KM3', (rec) => () => {
      asked++;
      const other = JSON.parse(JSON.stringify(rec)) as SerializedClient;
      other.state.seat = 2;
      return { client: other };
    });
    expect(t.client.state.audits.filter((a) => a.audit.handNumber === 0).every((a) => a.status !== 'failed' || !a.failures.some((f) => failureKey(f) === 'moveInvented'))).toBe(true);
    expect(t.client.serialize().handsEnded).not.toContain(-1);
    expect(asked).toBe(1);
  });
});

describe('a kept record taken up by the room joined (`fromArchive`)', () => {
  it('joins as the device the record was made on: a move written in the player\'s name while the phone was away fails the hand, with the journal', () => {
    const journal: unknown[] = [];
    const t = table('KA1', journal);
    t.run(() => t.host.game !== null && t.host.game.actionLog.filter((e) => e.seat === 0 && e.source === 'player').length >= 2 && !t.owes());
    const rec = JSON.parse(JSON.stringify(t.client.serialize())) as SerializedClient;
    t.away();
    let forged = false;
    t.run(() => {
      const a = t.owes() ? t.other() : undefined;
      if (a) {
        t.inside.apply(0, a, 'player');
        forged = true;
      }
      return forged;
    }, 2000);
    expect(forged).toBe(true);
    // The app's take-up by room: the record, its token, and the journal of the match.
    t.backWith((l, o) => TableClient.fromArchive(rec, l, 'A', undefined, { userId: USER }, { ...o, journal }));
    t.run(() => t.client.state.audits.some((a) => a.audit.handNumber === 0));
    expect(verdicts(t.client)).toContainEqual(expect.stringMatching(/^0:failed .*moveInvented/));
  });
});

describe('the red hands the app kept of a match, for a client that holds no record of it', () => {
  it('come back at the welcome naming the match: the match is shown failed, and a red hand it is shown fails again', () => {
    const t = table('KR1');
    t.run(() => t.client.state.view !== null);
    const m = t.client.state.matchId!;
    t.away();
    t.back(() => ({ red: [{ matchId: m, hand: 0, failures: ['Host sent a malformed frame'] }, { matchId: 'm-other', hand: 0, failures: ['Host sent a malformed frame'] }] }));
    t.run(() => t.client.state.matchId !== null);
    expect(t.client.state.matchFailed).toBe(true);
    expect(t.client.state.matchEndVerified).toBe(false);
    t.run(() => t.client.state.audits.some((a) => a.audit.handNumber === 0));
    expect(verdicts(t.client).filter((v) => v.startsWith('0:'))).toEqual([expect.stringMatching(/^0:failed .*malformedFrame/)]);
  });

  it('those of another match change nothing', () => {
    const t = table('KR2');
    t.run(() => t.client.state.view !== null);
    t.away();
    t.back(() => ({ red: [{ matchId: 'm-other', hand: 0, failures: ['Host sent a malformed frame'] }] }));
    t.run(() => t.client.state.matchId !== null);
    expect(t.client.state.matchFailed).toBe(false);
  });

  it('keepRed before the first welcome keeps them for the match it names', () => {
    const t = table('KR3');
    t.run(() => t.client.state.view !== null);
    const m = t.client.state.matchId!;
    t.away();
    let before: boolean | null = null;
    t.back(undefined, (c) => {
      c.keepRed([{ matchId: m, hand: 0, failures: ['Host sent a malformed frame'] }]);
      before = c.state.matchFailed;
    });
    expect(before).toBe(false);
    t.run(() => t.client.state.matchId !== null);
    expect(t.client.state.matchFailed).toBe(true);
  });
});
