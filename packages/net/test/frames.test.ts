/**
 * Frames that are not frames. A server (or a broken network) can put anything on the wire: an
 * empty body, the text `undefined`, `null`, a number, an array, a truncated frame, a huge string.
 * Every entry point on the client side (the socket of the signalling client, the relay to the
 * table, the transport link and the table client itself) drops such a body without throwing; it
 * changes nothing the audit keeps, and it does not count as hearing from the table.
 */
import { describe, expect, it } from 'vitest';
import { withRules } from '@mjm/engine';
import { LoopbackHub, RelayTransport, SILENT_ANSWER_MS, CLOCK_FRAME_MS, SignalingClient, TableClient, TableHost, isFrame, parseWire, serverFrame, transportLink, type HostMessage, type Link, type WebSocketLike } from '../src/index';
import { seededDeals } from './support';

seededDeals();

const HUGE = 'x'.repeat(2_000_000);
/** Bodies that are not JSON at all. */
const NOT_JSON = ['', ' ', 'undefined', 'NaN', '{', '[', '{"t":', '{"t":"pong","now":1', '{"t":"from","from":"host","data":{"ch":"game","msg":{"t":"welcome"', '"unterminated', HUGE, `{"t":"pong","pad":"${HUGE}`];
/** Bodies that are JSON but not a frame (not an object with a string `t`). */
const NOT_FRAMES = ['null', '0', '42', '-1.5', '1e400', 'true', 'false', '"text"', '"undefined"', `"${HUGE}"`, '[]', '[1,2,3]', '[{"t":"pong","now":1}]', '{}', '{"t":5}', '{"t":null}', '{"t":["pong"]}', `[${'0,'.repeat(100_000)}0]`];
const BODIES = [...NOT_JSON, ...NOT_FRAMES];
/** The same, as the values a table frame may carry inside a relay envelope. */
const VALUES: unknown[] = [undefined, null, 0, 42, -1.5, NaN, Infinity, true, '', 'undefined', HUGE, [], [1, 2], [{ t: 'pong', now: 1 }], {}, { t: 5 }, { t: null }];

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }
  body(data: unknown): void {
    this.onmessage?.({ data });
  }
  says(msg: unknown): void {
    this.body(JSON.stringify(msg));
  }
}

async function signalling() {
  let socket!: FakeSocket;
  const c = new SignalingClient('ws://test', () => (socket = new FakeSocket()));
  const p = c.connect();
  socket.readyState = 1;
  socket.onopen?.({});
  socket.says({ t: 'hello', id: 'me' });
  await p;
  return { c, socket };
}

/** A playing table over the loopback: the host's own transport can also put anything on the wire to the seat. */
function playing(code: string) {
  const clock = { now: 5_000_000 };
  const hub = new LoopbackHub();
  const hostWire = hub.create('host');
  const host = new TableHost(hostWire, { roomCode: code, rules: withRules({ handsPerMatch: 1, turnSeconds: 15, timeBankSeconds: 30 }), now: () => clock.now, matchId: `m-${code}` });
  const base = transportLink(hub.create('p0'), 'host');
  let cb: ((m: HostMessage) => void) | null = null;
  const net = {
    /** The server holds every frame of the table (pongs included) while true. */
    holding: false,
    /** Put a value straight onto the seat's link, past the hold. */
    inject: (m: unknown) => cb?.(m as HostMessage),
  };
  const link: Link = {
    ...base,
    onMessage: (f) => {
      cb = f;
      return base.onMessage((m) => {
        if (!net.holding) f(m);
      });
    },
  };
  const c = new TableClient(link, 'Victim', undefined, {}, { now: () => clock.now });
  c.join();
  host.start();
  for (let i = 0; i < 20 && !(c.state.view && host.phase === 'playing'); i++) {
    clock.now += 500;
    host.tick();
  }
  expect(c.state.view).not.toBeNull();
  return { clock, hub, hostWire, host, c, net };
}

/** What the client keeps for its audits, as it would save it. */
const kept = (c: TableClient) => JSON.stringify(c.serialize());

describe('the wire helpers', () => {
  it('parseWire gives null for every body that is not JSON, and the value otherwise', () => {
    for (const b of NOT_JSON) expect(parseWire(b)).toBeNull();
    for (const d of [undefined, null, 42, {}, new ArrayBuffer(4)]) expect(parseWire(d)).toBeNull();
    expect(parseWire('null')).toEqual({ value: null });
    expect(parseWire('{"t":"pong"}')).toEqual({ value: { t: 'pong' } });
  });

  it('isFrame accepts only an object with a string type', () => {
    for (const b of NOT_FRAMES) expect(isFrame(parseWire(b)!.value)).toBe(false);
    for (const v of VALUES) expect(isFrame(v)).toBe(false);
    expect(isFrame({ t: 'pong' })).toBe(true);
  });

  it('serverFrame drops what the signalling client would misread', () => {
    for (const b of BODIES) expect(serverFrame(b)).toBeNull();
    expect(serverFrame('{"t":"room","room":"R","peers":"p","host":"h"}')).toBeNull();
    expect(serverFrame('{"t":"room","room":"R","peers":[1],"host":"h"}')).toBeNull();
    expect(serverFrame('{"t":"peer","peerId":5,"event":"join"}')).toBeNull();
    expect(serverFrame('{"t":"peer","peerId":"p","event":"stay"}')).toBeNull();
    expect(serverFrame('{"t":"from","data":{}}')).toBeNull();
    expect(serverFrame('{"t":"matched"}')).toBeNull();
    expect(serverFrame('{"t":"room","room":"R","peers":["h"],"host":"h"}')).toEqual({ t: 'room', room: 'R', peers: ['h'], host: 'h' });
    expect(serverFrame('{"t":"something_new","x":1}')).toEqual({ t: 'something_new', x: 1 });
  });
});

describe('the signalling client', () => {
  it('drops every malformed body without throwing, and still works after', async () => {
    const { c, socket } = await signalling();
    const heard: unknown[] = [];
    c.onMessage((m) => heard.push(m));
    const pending = c.createRoom('R');
    for (const b of BODIES) expect(() => socket.body(b)).not.toThrow();
    for (const d of [undefined, null, 42, {}, new ArrayBuffer(4)]) expect(() => socket.body(d)).not.toThrow();
    // A room reply the client would misread does not answer the request, and a peer frame after it cannot fail.
    for (const m of [{ t: 'room', room: 'R', peers: 'h', host: 'h' }, { t: 'room', room: 'R', peers: [null], host: 'h' }, { t: 'peer', peerId: null, event: 'join' }, { t: 'from', data: null }, { t: 'matched' }]) expect(() => socket.says(m)).not.toThrow();
    expect(heard).toEqual([]);
    socket.says({ t: 'room', room: 'R', peers: ['h', 'me'], host: 'h' });
    await expect(pending).resolves.toEqual({ room: 'R', peers: ['h', 'me'], host: 'h' });
    expect(() => socket.says({ t: 'peer', peerId: 'x', event: 'join' })).not.toThrow();
    expect(c.room?.peers).toEqual(['h', 'me', 'x']);
  });

  it('a table client behind the relay drops malformed table frames and keeps its record unchanged', async () => {
    const { c: sig, socket } = await signalling();
    const relay = new RelayTransport(sig);
    const client = new TableClient(transportLink(relay, 'host'), 'Victim');
    const before = kept(client);
    const from = (data: unknown) => `{"t":"from","from":"host","data":${data}}`;
    for (const b of BODIES) {
      expect(() => socket.body(from(b))).not.toThrow();
      expect(() => socket.body(from(`{"ch":"game","msg":${b}}`))).not.toThrow();
    }
    for (const v of VALUES) expect(() => socket.says({ t: 'from', from: 'host', data: { ch: 'game', msg: v } })).not.toThrow();
    expect(kept(client)).toBe(before);
    expect(client.state.lastError).toBeNull();
    // A well-formed frame still gets through.
    socket.says({ t: 'from', from: 'host', data: { ch: 'game', msg: { t: 'pong', at: 0, now: 1 } } });
    expect(client.state.rttMs).not.toBeNull();
  });
});

describe('the loopback wire and the table client', () => {
  it('a host that puts anything on the wire to a playing seat throws nothing and changes nothing the audit keeps', () => {
    const t = playing('FZ1');
    const before = kept(t.c);
    const state = t.c.state;
    for (const v of [...VALUES, () => 1, Symbol('s')]) expect(() => t.hostWire.send('p0', v)).not.toThrow();
    for (const b of BODIES) expect(() => t.net.inject(b)).not.toThrow();
    for (const b of NOT_FRAMES) expect(() => t.net.inject(parseWire(b)!.value)).not.toThrow();
    for (const v of VALUES) expect(() => t.net.inject(v)).not.toThrow();
    expect(kept(t.c)).toBe(before);
    expect(t.c.state).toBe(state);
  });

  it('frames that are not frames do not keep a silent link alive', () => {
    const t = playing('FZ2');
    // The phone's watch runs once a second from here; the server holds every table frame, and puts junk on the link instead.
    expect(t.c.checkLink()).toBe('ok');
    t.net.holding = true;
    const from = t.clock.now;
    let silentAt: number | null = null;
    for (let s = 0; s < 40 && silentAt === null; s++) {
      t.clock.now += 1_000;
      t.net.inject(VALUES[s % VALUES.length]);
      t.net.inject(BODIES[s % BODIES.length]);
      t.host.tick();
      if (t.c.checkLink() === 'silent') silentAt = t.clock.now;
    }
    expect(silentAt).not.toBeNull();
    expect(silentAt! - from).toBeLessThanOrEqual(2 * CLOCK_FRAME_MS + 2_000 + SILENT_ANSWER_MS + 1_000);
  });
});
