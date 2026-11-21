/**
 * What a server can make the app save of a table, and a red verdict that outlives a save that was not written.
 *
 * Every frame is held to the protocol's bounds at intake (names, codes, tokens, messages, and the size of a view, a
 * result and an audit as JSON), and an audit is filed with the fields the checks read and no other: an audit padded with a
 * field no check reads stays the size an honest one is, and one padded past any honest size is malformed (red). The
 * record the app saves holds each audit once and stays within `RECORD_MAX_CHARS`, giving up the oldest audits that are not
 * red first. The hands found red go to a small list the app saves apart (`redHands`); a client restored from a record saved
 * before a hand failed takes them back (`keepRed`), so a save that was not written does not turn red into amber.
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { failureKey, TableClient, type HostMessage, type SerializedClient } from '../src/index';
import { BOUNDS, intake, keptAudit } from '../src/intake';
import { fitRecord, RECORD_MAX_CHARS } from '../src/clientrecords';
import { Missed, scenario, seededDeals } from './support';
import { wire } from './wire';

seededDeals();

const need = (cond: boolean) => {
  if (!cond) throw new Missed();
};
const TWO = withRules({ handsPerMatch: 2, turnSeconds: 15, timeBankSeconds: 30 });
const SEATS = [0, 1, 2, 3].map((seat) => ({ seat, name: `P${seat}`, peerId: seat === 0 ? 'p0' : null, isBot: seat !== 0, connected: true }));
const AUDIT = { matchId: 'm-SZ', handNumber: 0, seed: 's', commits: [{ seat: 0, hash: 'h' }], reveals: [{ seat: 0, secret: 's' }], log: [{ n: 0, seat: 0, action: { type: 'discard', tile: 5 }, source: 'player' }], finalHash: 'h', rngVersion: 'v', ceremonyAttempts: 1, restarts: [{ attempt: 1, seats: [0], cause: 'no_reveal' }], restartReasons: ['seat 1 did not reveal'] };
const WELCOME = { t: 'welcome', seat: 0, roomCode: 'ABC123', rules: {}, seats: SEATS, matchId: 'm-SZ', token: 'tok' };

describe('the bounds a frame is held to at intake', () => {
  it("a server's words past their bounds are malformed: names, room codes, match ids, tokens, messages, hashes", () => {
    expect(intake(WELCOME)?.ok).toBe(true);
    const long = (n: number) => 'x'.repeat(n + 1);
    for (const bad of [
      { ...WELCOME, seats: SEATS.map((s, i) => (i === 1 ? { ...s, name: long(BOUNDS.name) } : s)) },
      { ...WELCOME, seats: SEATS.map((s, i) => (i === 1 ? { ...s, userId: long(BOUNDS.id) } : s)) },
      { ...WELCOME, roomCode: long(BOUNDS.room) },
      { ...WELCOME, matchId: long(BOUNDS.id) },
      { ...WELCOME, token: long(BOUNDS.id) },
      { ...WELCOME, rules: { pad: long(BOUNDS.rules) } },
      { t: 'error', code: 'full', message: long(BOUNDS.text) },
      { t: 'chat', seat: 1, name: long(BOUNDS.name), text: 'hi' },
    ])
      expect(intake(bad)?.ok).toBe(false);
    expect(intake({ t: 'error', code: 'full', message: 'x'.repeat(BOUNDS.text) })?.ok).toBe(true);
  });

  it('an audit, a view or a result larger as JSON than any honest one is malformed', () => {
    const view = { handNumber: 0, turnCounter: 3, players: [0, 1, 2, 3].map(() => ({ handCount: 16, melds: [], flowers: [], discards: [] })), scores: [0, 0, 0, 0] };
    const over = { t: 'hand_over', result: {}, audit: AUDIT, view, now: 1 };
    expect(intake(over)?.ok).toBe(true);
    expect(intake({ ...over, audit: { ...AUDIT, note: 'x'.repeat(BOUNDS.audit) } })).toEqual({ ok: false, t: 'hand_over', field: 'audit' });
    expect(intake({ ...over, result: { note: 'x'.repeat(BOUNDS.result) } })).toEqual({ ok: false, t: 'hand_over', field: 'result' });
    expect(intake({ ...over, view: { ...view, note: 'x'.repeat(BOUNDS.view) } })).toEqual({ ok: false, t: 'hand_over', field: 'view' });
    expect(intake({ t: 'hand_missed', audit: { ...AUDIT, note: 'x'.repeat(BOUNDS.audit) } })?.ok).toBe(false);
    expect(intake({ t: 'state', view, hash: 'x'.repeat(BOUNDS.hash + 1), deadline: null, timeBank: 0, inTimeBank: false, now: 1 })?.ok).toBe(false);
  });

  it('an audit is filed with the fields the checks read and no other, at every level; nothing that is there is changed', () => {
    const padded = { ...AUDIT, note: 'pad', commits: [{ seat: 0, hash: 'h', pad: 1 }], reveals: [{ seat: 0, secret: 's', pad: 1 }], log: [{ n: 0, seat: 0, action: { type: 'discard', tile: 5, pad: 1 }, source: 'player', pad: 1 }, 'junk'], restarts: [{ attempt: 1, seats: [0], cause: 'no_reveal', pad: 1 }] };
    const kept = keptAudit(padded as never);
    expect(kept).toEqual({ ...AUDIT, log: [AUDIT.log[0], 'junk'], restartReasons: [] });
    const frame = intake({ t: 'hand_missed', audit: padded });
    expect(frame?.ok && (frame.frame as Extract<HostMessage, { t: 'hand_missed' }>).audit).toEqual(kept);
    // So are the seats a welcome lists.
    const welcome = intake({ ...WELCOME, seats: SEATS.map((s) => ({ ...s, pad: 'x'.repeat(50) })) });
    expect(welcome?.ok && (welcome.frame as Extract<HostMessage, { t: 'welcome' }>).seats).toEqual(SEATS);
  });
});

/** A match of two hands; the server pads hand 0's audit with `pad` characters in a field no check reads. */
function padded(code: string, pad: number) {
  const w = wire({ code, rules: TWO, botDelayMs: 500, intermissionSeconds: 5, think: () => 700, map: (m) => (m.t === 'hand_over' && m.audit.handNumber === 0 ? { ...m, audit: { ...m.audit, note: 'x'.repeat(pad) } } : m) });
  for (let k = 0; k < 20_000 && !w.c.state.audits.some((a) => a.audit.handNumber === 0); k++) w.step();
  return w;
}

describe('what a padded audit does to the hand and to the record', () => {
  it('padding within the bounds is not filed: the hand is green and the record is the size an honest one is', () =>
    scenario((i) => {
      const w = padded(`SZA${i}`, 20_000);
      const a = w.c.state.audits.find((x) => x.audit.handNumber === 0);
      need(!!a);
      expect(a!.status).toBe('ok');
      expect(JSON.stringify(w.c.serialize()).length).toBeLessThan(60_000);
    }));

  it('padding past any honest size is a malformed frame, taken as nothing: the match is red (hand 0 was green, and the record over 6 million characters)', () =>
    scenario((i) => {
      const w = padded(`SZB${i}`, 3_000_000);
      for (let k = 0; k < 40_000 && !w.c.state.matchOver && !w.c.state.audits.some((a) => a.status === 'failed'); k++) w.step();
      expect(w.c.state.matchFailed).toBe(true);
      // The padded result never went on show; the hand the table moved on to carries the failure.
      const red = w.c.state.audits.find((a) => a.status === 'failed');
      need(!!red);
      expect(red!.failures.map(failureKey)).toContain('malformedFrame');
      expect(w.c.state.audits.some((a) => a.audit.handNumber === 0 && a.status === 'ok')).toBe(false);
      expect(JSON.stringify(w.c.serialize()).length).toBeLessThan(RECORD_MAX_CHARS);
    }));
});

describe('the record the app saves', () => {
  it('holds the last audit once, and a client restored from it shows it as before', () =>
    scenario((i) => {
      const w = wire({ code: `SZC${i}`, rules: TWO, botDelayMs: 500, intermissionSeconds: 5, think: () => 700 });
      for (let k = 0; k < 20_000 && !w.c.state.lastAudit; k++) w.step();
      need(!!w.c.state.lastAudit);
      const saved = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
      expect(saved.state.lastAudit).toBeNull();
      expect(saved.lastAuditAt).toBe(saved.state.audits.length - 1);
      w.restart();
      expect(w.c.state.lastAudit).toEqual(saved.state.audits[saved.lastAuditAt!].audit);
      expect(JSON.parse(JSON.stringify(w.c.serialize()))).toMatchObject({ lastAuditAt: saved.lastAuditAt, state: { lastAudit: null } });
    }));

  it('stays within its bound however many large audits it holds: the oldest that are not red go first, then red ones, never the last two', () => {
    const big = (h: number, status: 'ok' | 'failed') => ({ audit: { ...AUDIT, handNumber: h, log: Array.from({ length: 900 }, (_, n) => ({ n, seat: n % 4, action: { type: 'pass' }, source: 'auto' })) }, status, failures: status === 'failed' ? ['Host sent a malformed frame'] : [], caveats: [] });
    const audits = Array.from({ length: 50 }, (_, h) => big(h, h % 10 === 3 ? 'failed' : 'ok'));
    const rec = { version: 2, state: { audits, lastAudit: audits[49].audit, matchId: 'm-SZ' }, plays: [], records: [] } as unknown as SerializedClient;
    expect(JSON.stringify(rec).length).toBeGreaterThan(RECORD_MAX_CHARS);
    const fit = fitRecord(rec, () => true);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(RECORD_MAX_CHARS);
    const hands = fit.state.audits.map((a) => a.audit.handNumber);
    expect(hands.slice(-2)).toEqual([48, 49]);
    // Every red one is still there (they went last), and the last audit is the entry it is.
    for (const h of [3, 13, 23, 33, 43]) expect(hands).toContain(h);
    expect(fit.state.audits[fit.lastAuditAt!].audit).toBe(audits[49].audit);
    // A record within the bound is saved as it is.
    const small = { ...rec, state: { ...rec.state, audits: audits.slice(-3) } } as SerializedClient;
    expect(fitRecord(small, () => true).state.audits).toHaveLength(3);
  });
});

describe('a red verdict that a save did not write', () => {
  /** Two hands; in hand 1 the server sends one malformed frame (the hand is red). The app's saves stop after hand 0's end. */
  function redAfterLastSave(code: string) {
    let bad = false;
    let saved: SerializedClient | null = null;
    const w = wire({
      code,
      rules: TWO,
      botDelayMs: 500,
      intermissionSeconds: 5,
      think: () => 700,
      after: (m) => {
        if (bad || m.t !== 'state' || m.view.handNumber !== 1 || m.view.turnCounter < 4) return [];
        bad = true;
        return [{ t: 'commit_request', handNumber: -1 } as unknown as HostMessage];
      },
    });
    for (let k = 0; k < 40_000 && !w.c.state.audits.some((a) => a.audit.handNumber === 1); k++) {
      w.step();
      // The last record storage could take: hand 0 over, before hand 1 was dealt.
      if (!saved && w.c.state.audits.some((a) => a.audit.handNumber === 0)) saved = JSON.parse(JSON.stringify(w.c.serialize())) as SerializedClient;
    }
    const red = w.c.state.audits.find((a) => a.audit.handNumber === 1);
    return { w, saved, red, list: JSON.parse(JSON.stringify(w.c.redHands())) as unknown[] };
  }

  it('the list of red hands brings hand 1 back red on a client restored from a record saved before it failed (it came back amber)', () =>
    scenario((i) => {
      const r = redAfterLastSave(`SZD${i}`);
      need(!!r.saved && r.red?.status === 'failed');
      expect(r.list).toEqual([{ matchId: r.red!.audit.matchId, hand: 1, failures: r.red!.failures }]);
      // Cold start: storage held the record of hand 0; the table sends hand 1's record as a missed hand.
      const without = TableClient.restore(r.saved, { send: () => undefined, onMessage: () => () => undefined, close: () => undefined }, 'Victim');
      expect(without.state.audits.some((a) => a.audit.handNumber === 1)).toBe(false);
      const back = TableClient.restore(r.saved, { send: () => undefined, onMessage: () => () => undefined, close: () => undefined }, 'Victim');
      back.keepRed(r.list);
      expect(back.state.matchFailed).toBe(true);
      // Hand 1 had not ended in that record: its failures go into its own audit when its record comes.
      expect((back as unknown as { tamper: Map<number, string[]> }).tamper.get(1)).toEqual(r.red!.failures);
    }));

  it('a hand that ended in the record comes back listed red; entries of another match, or damaged ones, are left out', () =>
    scenario((i) => {
      const r = redAfterLastSave(`SZE${i}`);
      need(!!r.saved && r.red?.status === 'failed');
      const ended = JSON.parse(JSON.stringify(r.w.c.serialize())) as SerializedClient;
      // A record that holds hand 1's end but not its red verdict (as if the failure came after its last save).
      ended.state.audits = ended.state.audits.map((a) => (a.audit.handNumber === 1 ? { ...a, status: 'partial' as const, failures: [] } : a));
      ended.state.matchFailed = false;
      const link = { send: () => undefined, onMessage: () => () => undefined, close: () => undefined };
      const c = TableClient.restore(ended, link, 'Victim');
      c.keepRed([{ matchId: 'another', hand: 1, failures: ['x'] }, { matchId: r.red!.audit.matchId, hand: 'one', failures: ['x'] }, null]);
      expect(c.state.matchFailed).toBe(false);
      c.keepRed(r.list);
      expect(c.state.audits.filter((a) => a.audit.handNumber === 1).map((a) => a.status)).toEqual(['partial', 'failed']);
      expect(c.state.matchFailed).toBe(true);
      // Listed once: a second reading adds nothing.
      c.keepRed(r.list);
      expect(c.state.audits.filter((a) => a.audit.handNumber === 1)).toHaveLength(2);
    }));
});
