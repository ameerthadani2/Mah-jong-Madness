import { describe, expect, it } from 'vitest';
import { chooseAction, legalActions, sanitizeRules, withRules, type RuleSet } from '@mjm/engine';
import { LoopbackHub, TableClient, TableHost, transportLink } from '../src/index';

function makeTable(humans: number, opts: { latency?: number; handsPerMatch?: number } = {}) {
  const hub = new LoopbackHub(opts.latency ?? 0);
  const hostTransport = hub.create('host');
  const host = new TableHost(hostTransport, { roomCode: 'TEST01', rules: withRules({ handsPerMatch: opts.handsPerMatch ?? 1, turnSeconds: 5 }), matchId: 'm1' });
  const clients: TableClient[] = [];
  for (let i = 0; i < humans; i++) {
    const t = hub.create(`p${i}`);
    const c = new TableClient(transportLink(t, 'host'), `Player ${i}`);
    c.join();
    clients.push(c);
  }
  return { hub, host, clients };
}

/** Drive the human clients with the bot policy until the hand is over. */
function autoplayHand(host: TableHost, clients: TableClient[]): void {
  let guard = 0;
  while (host.phase === 'playing') {
    let acted = false;
    for (const c of clients) {
      const s = c.localState();
      if (!s || c.state.seat === null) continue;
      if (legalActions(s, c.state.seat).length === 0) continue;
      const a = chooseAction(s, c.state.seat, { seed: `h${c.state.seat}` });
      if (a) {
        c.act(a);
        acted = true;
        break;
      }
    }
    if (!acted) throw new Error(`stuck: host phase ${host.phase}`);
    if (++guard > 3000) throw new Error('hand did not finish');
  }
}

describe('P2P table over loopback', () => {
  it('seats players, runs the ceremony, plays a hand and both clients verify the audit', () => {
    const { host, clients } = makeTable(2);
    expect(clients[0].state.seat).toBe(0);
    expect(clients[1].state.seat).toBe(1);
    host.start();
    expect(host.phase).toBe('playing');
    for (const c of clients) {
      expect(c.state.view).not.toBeNull();
      expect(c.state.view!.players[c.state.seat!].hand).toBeDefined();
      // Hidden information is stripped
      for (let i = 0; i < 4; i++) if (i !== c.state.seat) expect(c.state.view!.players[i].hand).toBeUndefined();
    }
    autoplayHand(host, clients);
    expect(host.phase).toBe('hand_over');
    for (const c of clients) {
      expect(c.state.lastResult).not.toBeNull();
      expect(c.state.auditStatus).toBe('ok');
      expect(c.state.auditFailures).toEqual([]);
    }
    // Everyone ready → match of 1 dealer rotation may continue if dealer won; play until over.
    let guard = 0;
    while (host.phase !== 'match_over' && guard++ < 50) {
      for (const c of clients) c.ready();
      if (host.phase === 'playing') autoplayHand(host, clients);
    }
    expect(host.phase).toBe('match_over');
    expect(clients[0].state.matchOver).toBe(true);
    expect(clients[0].state.finalScores!.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('rejects actions for the wrong seat or out of turn', () => {
    const { host, clients } = makeTable(2);
    host.start();
    const c = clients[1];
    const other = clients[0];
    // Pretend to act for seat 0 from seat 1's connection
    (c as unknown as { send: (m: unknown) => void }).send({ t: 'action', seat: 0, action: { type: 'pass' } });
    expect(c.state.lastError).toMatch(/own seat/);
    const s = other.localState()!;
    if (legalActions(s, 0).length === 0) {
      other.act({ type: 'pass' });
      expect(other.state.lastError).toMatch(/cannot/);
    }
  });

  it('detects a tampered audit', () => {
    const { host, clients } = makeTable(1);
    host.start();
    autoplayHand(host, clients);
    const c = clients[0];
    const audit = c.state.lastAudit!;
    const tampered = { ...audit, reveals: audit.reveals.map((r) => (r.seat === 2 ? { ...r, secret: 'evil' } : r)) };
    const res = c.verifyAudit(tampered, c.state.view!);
    expect(res.status).toBe('failed');
    expect(res.failures.join(' ')).toMatch(/Reveals do not match/);
    const tamperedLog = { ...audit, log: audit.log.slice(0, -1) };
    expect(c.verifyAudit(tamperedLog, c.state.view!).status).toBe('failed');
  });

  it('times out a slow human and lets the bot stand in', () => {
    let now = 1_000_000;
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'T', rules: withRules({ handsPerMatch: 1, turnSeconds: 5 }), now: () => now });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Slow');
    c.join();
    host.start();
    expect(host.phase).toBe('playing');
    // The human never acts; advance the clock past every deadline.
    let guard = 0;
    while (host.phase === 'playing' && guard++ < 500) {
      now += 6000;
      host.tick();
    }
    expect(host.phase).toBe('hand_over');
    expect(c.state.auditStatus).toBe('ok');
  });

  it('a disconnected human is played by a bot and can rejoin', () => {
    const { hub, host, clients } = makeTable(2);
    host.start();
    // Drop player 1 mid-hand
    const t1 = (hub as unknown as { nodes: Map<string, { close: () => void }> }).nodes.get('p1')!;
    t1.close();
    let guard = 0;
    while (host.phase === 'playing' && guard++ < 3000) {
      const c = clients[0];
      const s = c.localState()!;
      if (legalActions(s, 0).length > 0) c.act(chooseAction(s, 0)!);
      else break; // bots took over everything else; host should have advanced
    }
    expect(['playing', 'hand_over']).toContain(host.phase);
    // Rejoining with just the (public) name must NOT reclaim the seat; the token must.
    const impostor = new TableClient(transportLink(hub.create('p1x'), 'host'), 'Player 1');
    impostor.join();
    expect(impostor.state.seat).not.toBe(1);
    const token = clients[1].state.token!;
    const c1b = new TableClient(transportLink(hub.create('p1b'), 'host'), 'Player 1', undefined, { token });
    c1b.join();
    expect(c1b.state.seat).toBe(1);
  });

  it('a host given unsanitised rules deals with the same rule set its clients replay with', () => {
    // Port of integration/oldrules.ts: a rule set saved by an older build (no 天/地/人胡 values) plus junk.
    const { heavenlyTai: _h, earthlyTai: _e, humanlyTai: _u, ...old } = withRules({ handsPerMatch: 1, turnSeconds: 5 });
    void [_h, _e, _u];
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'OLD', rules: { ...old, evil: true } as unknown as RuleSet, matchId: 'm' });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Me');
    c.join();
    expect(host.rules).toEqual(sanitizeRules({ ...old, evil: true }));
    expect(c.state.rules).toEqual(host.rules);
    host.start();
    autoplayHand(host, [c]);
    expect([c.state.auditStatus, c.state.auditFailures]).toEqual(['ok', []]);
  });
});
