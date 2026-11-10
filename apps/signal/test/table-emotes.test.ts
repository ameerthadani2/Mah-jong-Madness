/**
 * Emotes at a server-hosted table: free emotes always pass, an emote from a paid pack only for an
 * account that owns the pack, and ownership is read once and remembered so an emote does not
 * cost a database round trip. Ends with the real server, where ownership comes from the wallet.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RelayTransport, SignalingClient, TableClient, transportLink, type WebSocketLike } from '@mjm/net';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createRepos } from '../src/repos';
import { EMOTE_PACKS_RECHECK_MS, EMOTE_PACKS_TTL_MS, EmotePackOwners, RoomRegistry, type Socket } from '../src/rooms';
import { createSignalServer, type SignalServer } from '../src/server';

type Out = { t: string; data?: { msg?: { t?: string; emote?: string; seat?: number } } };
const tick = () => new Promise((r) => setTimeout(r, 0));

function table(owned: Record<string, string[]>) {
  const clock = { now: 1_000_000 };
  const reads: string[] = [];
  const packs = new EmotePackOwners(
    async (userId) => {
      reads.push(userId);
      return owned[userId] ?? [];
    },
    { now: () => clock.now },
  );
  const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 0, now: () => clock.now, emotePacks: packs });
  const code = rooms.createHostedRoom();
  const sit = (userId: string | undefined) => {
    const out: Out[] = [];
    const socket: Socket = { send: (j) => out.push(JSON.parse(j) as Out), close: () => undefined };
    const id = userId ? rooms.hello(rooms.connect(socket), userId) : rooms.handle(rooms.connect(socket), { t: 'hello' });
    rooms.handle(id, { t: 'join', room: code });
    const say = (msg: Record<string, unknown>) => rooms.handle(id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg } });
    say({ t: 'join', name: 'x' });
    return { id, say, emote: (emote: unknown) => say({ t: 'emote', emote }), seen: () => out.filter((m) => m.data?.msg?.t === 'emote').map((m) => `${m.data!.msg!.seat}:${m.data!.msg!.emote}`) };
  };
  /** The table lets a seat emote once every two seconds. */
  const wait = (ms = 2_000) => (clock.now += ms);
  return { rooms, code, clock, reads, sit, wait, packs };
}

describe('paid emotes at a hosted table', () => {
  it("drops a pack emote from an account that does not own the pack, and relays the owner's", async () => {
    const t = table({ 'user-owner-1': ['emotes.zodiac', 'theme.jade'] });
    const owner = t.sit('user-owner-1');
    const other = t.sit('user-other-1');
    await tick();
    other.emote('zd.dragon');
    await tick();
    expect(owner.seen()).toEqual([]);
    // A free emote from the same seat still goes out.
    other.emote('thumbs');
    expect(owner.seen()).toEqual(['1:thumbs']);
    owner.emote('zd.dragon');
    expect(other.seen()).toEqual(['1:thumbs', '0:zd.dragon']);
    // A pack the owner does not hold is dropped for them too.
    t.wait();
    owner.emote('nm.boba');
    await tick();
    expect(other.seen()).toEqual(['1:thumbs', '0:zd.dragon']);
  });

  it('drops an unknown emote id and anything that is not an id', async () => {
    const t = table({});
    const a = t.sit('user-a-1');
    const b = t.sit('user-b-1');
    for (const e of ['http://evil.example', 'zd.unicorn', 'constructor', '', 5, null, { id: 'thumbs' }]) {
      a.emote(e);
      t.wait();
    }
    await tick();
    expect(b.seen()).toEqual([]);
  });

  it('a peer without an account cannot send a pack emote', async () => {
    const t = table({});
    const anon = t.sit(undefined);
    const b = t.sit('user-b-1');
    anon.emote('th.tea');
    await tick();
    expect(b.seen()).toEqual([]);
    anon.emote('wow');
    expect(b.seen()).toEqual(['0:wow']);
  });

  it('reads an account once when it sits down and answers every emote from memory for a minute', async () => {
    const t = table({ 'user-owner-1': ['emotes.teahouse'] });
    const owner = t.sit('user-owner-1');
    const other = t.sit('user-other-1');
    await tick();
    expect(t.reads).toEqual(['user-owner-1', 'user-other-1']);
    for (let i = 0; i < 5; i++) {
      owner.emote('th.tea');
      t.wait();
    }
    expect(other.seen()).toHaveLength(5);
    expect(t.reads).toHaveLength(2);
    // After the minute the next pack emote reads again, and is delivered once the answer is in.
    t.wait(EMOTE_PACKS_TTL_MS);
    owner.emote('th.bun');
    expect(other.seen()).toHaveLength(5);
    await tick();
    expect(other.seen()).toHaveLength(6);
    expect(t.reads).toEqual(['user-owner-1', 'user-other-1', 'user-owner-1']);
  });

  it('a pack bought during the match works within seconds, without a read per refused emote', async () => {
    const owned: Record<string, string[]> = {};
    const t = table(owned);
    const buyer = t.sit('user-buyer-1');
    const other = t.sit('user-other-1');
    await tick();
    for (let i = 0; i < 3; i++) {
      buyer.emote('fs.kite');
      t.wait();
    }
    await tick();
    expect(other.seen()).toEqual([]);
    expect(t.reads.filter((id) => id === 'user-buyer-1')).toHaveLength(1);
    owned['user-buyer-1'] = ['emotes.festival'];
    t.wait(EMOTE_PACKS_RECHECK_MS);
    buyer.emote('fs.kite');
    await tick();
    expect(other.seen()).toEqual(['0:fs.kite']);
    expect(t.reads.filter((id) => id === 'user-buyer-1')).toHaveLength(2);
  });

  it('keeps the last answer when ownership cannot be read, and drops the emote when there is none', async () => {
    const clock = { now: 0 };
    let fail = false;
    const packs = new EmotePackOwners(
      async () => {
        if (fail) throw new Error('database down');
        return ['emotes.zodiac'];
      },
      { now: () => clock.now },
    );
    expect(await packs.owns('u1', 'emotes.zodiac')).toBe(true);
    fail = true;
    clock.now += EMOTE_PACKS_TTL_MS + 1;
    expect(await packs.owns('u1', 'emotes.zodiac')).toBe(true);
    expect(await packs.owns('u2', 'emotes.zodiac')).toBe(false);
  });
});

const servers: SignalServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('paid emotes on the real server', () => {
  it("checks the sender's wallet: the pack's owner is seen, a player who never bought it is not", async () => {
    const repos = createRepos();
    const sessions = new SessionService(repos.repos, { pepper: 'emote-pepper-0123456789abcdef' });
    const server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions, providers: {}, config: loadConfig({}), botDelayMs: 0, persistDebounceMs: 20, log: () => undefined });
    servers.push(server);
    const port = server.address().port;
    const guest = async (name: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: { id: randomUUID(), platform: 'ios' }, displayName: name }) });
      return (await res.json()) as { userId: string; session: { token: string } };
    };
    const client = (token: string) =>
      new SignalingClient(`ws://127.0.0.1:${port}`, {
        auth: token,
        webSocket: (u) => {
          const ws = new WebSocket(u);
          sockets.push(ws);
          return ws as unknown as WebSocketLike;
        },
      });
    const [owner, other] = await Promise.all([guest('Owner'), guest('Other')]);
    await repos.repos.wallet.setEntitlement({ userId: owner.userId, entitlement: 'emotes.zodiac', expiresAt: null, source: 'diamonds', updatedAt: Date.now() });
    const oc = client(owner.session.token);
    const xc = client(other.session.token);
    await Promise.all([oc.connect(), xc.connect()]);
    const room = await oc.createHostedRoom({});
    await xc.joinRoom(room.room);
    const ot = new TableClient(transportLink(new RelayTransport(oc), room.host), 'Owner');
    const xt = new TableClient(transportLink(new RelayTransport(xc), room.host), 'Other');
    ot.join();
    xt.join();
    const until = async (ok: () => boolean) => {
      const end = Date.now() + 5_000;
      while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    };
    await until(() => ot.state.seat !== null && xt.state.seat !== null);
    xt.emote('zd.dragon');
    ot.emote('zd.dragon');
    await until(() => xt.state.emotes.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(xt.state.emotes.map((e) => `${e.seat}:${e.emote}`)).toEqual([`${ot.state.seat}:zd.dragon`]);
    expect(ot.state.emotes.map((e) => `${e.seat}:${e.emote}`)).toEqual([`${ot.state.seat}:zd.dragon`]);
    // Free text never arrives either.
    xt.chat('Official support: send me your password');
    xt.chat('gg');
    await until(() => ot.state.chat.length > 0);
    expect(ot.state.chat.map((c) => c.text)).toEqual(['gg']);
  });
});
