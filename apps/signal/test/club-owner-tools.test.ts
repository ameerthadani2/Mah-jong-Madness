/**
 * Club owner tools (probe `online-challenge/probeG.ts`, "owner powerless"): close a table, take a
 * player off a table, remove a member from the live tables as well, ban and unban, reject a request,
 * pass the club on, leave, and delete the club. Each runs through the real API handler with the
 * room registry gated by the club registry, as in the server.
 */
import { describe, expect, it } from 'vitest';
import { createApiHandler } from '../src/api';
import { SessionService } from '../src/auth';
import { ClubRegistry, clubGate, type Club } from '../src/clubs';
import { createMemoryRepos } from '../src/repos';
import { EVICTED_BY_CLUB, RoomRegistry, TABLE_CLOSED_BY_CLUB, type Socket } from '../src/rooms';
import { PEPPER, request } from './helpers';

type Frame = { t: string; code?: string; message?: string; room?: string; host?: string; data?: { ch?: string; msg?: { t: string; code?: string; message?: string; seat?: number; token?: string } } };

function fixture() {
  const repos = createMemoryRepos();
  const sessions = new SessionService(repos, { pepper: PEPPER });
  const clubs = new ClubRegistry({ store: repos.clubs });
  const rooms = new RoomRegistry({ allowHosted: true, clubs: clubGate(clubs), botDelayMs: 0 });
  const handler = createApiHandler({ clubs, rooms, repos, sessions });
  let n = 0;
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => request(handler, method, url, body, headers, `10.9.${Math.floor(++n / 250)}.${n % 250}`);
  const guest = async (displayName: string) => {
    const res = await call('POST', '/api/auth/guest', { device: { id: crypto.randomUUID(), platform: 'ios', appBuild: '1', locale: 'en' }, displayName });
    const token = (res.json.session as { token: string }).token;
    return { userId: res.json.userId as string, auth: { authorization: `Bearer ${token}` }, name: displayName };
  };
  /** A socket for this account in the room registry, able to sit at a table. */
  const socket = (userId: string) => {
    const out: Frame[] = [];
    const s: Socket = { send: (j) => out.push(JSON.parse(j) as Frame), close: () => undefined };
    const id = rooms.hello(rooms.connect(s), userId);
    let host = '';
    return {
      id,
      out,
      sit(room: string) {
        rooms.handle(id, { t: 'join', room });
        const reply = out[out.length - 1];
        if (reply.t !== 'room') return reply;
        host = reply.host!;
        rooms.handle(id, { t: 'to', to: host, data: { ch: 'game', msg: { t: 'join', name: userId } } });
        return reply;
      },
      game(msg: unknown) {
        rooms.handle(id, { t: 'to', to: host, data: { ch: 'game', msg } });
      },
      tableErrors: () => out.filter((m) => m.t === 'from' && m.data?.msg?.t === 'error').map((m) => m.data!.msg!),
    };
  };
  return { repos, clubs, rooms, call, guest, socket };
}

async function clubWith(f: ReturnType<typeof fixture>, names: string[]) {
  const owner = await f.guest('Owner');
  const club = (await f.call('POST', '/api/clubs', { name: 'Tools', rules: { handsPerMatch: 4 } }, owner.auth)).json as unknown as Club;
  const others = [];
  for (const n of names) {
    const g = await f.guest(n);
    await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth);
    others.push(g);
  }
  return { owner, club, others };
}

describe('closing a club table', () => {
  it('ends the table at once for everyone in it, removes the listing, and adds nothing to the standings', async () => {
    const f = fixture();
    const { owner, club, others } = await clubWith(f, ['Ah-Mei', 'Bo']);
    const [a, b] = others;
    const table = ((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, a.auth)).json as { code: string }).code;
    const sa = f.socket(a.userId);
    const sb = f.socket(b.userId);
    sa.sit(table);
    sb.sit(table);
    sa.game({ t: 'start' });
    expect(f.rooms.hostedTable(table)!.phase).not.toBe('lobby');
    // A plain member may not close it.
    expect((await f.call('POST', `/api/clubs/${club.code}/tables/${table}/close`, {}, b.auth)).status).toBe(403);
    const res = await f.call('POST', `/api/clubs/${club.code}/tables/${table}/close`, {}, owner.auth);
    expect(res.status).toBe(200);
    expect(f.rooms.hasRoom(table)).toBe(false);
    expect((res.json as unknown as Club).tables).toEqual([]);
    for (const s of [sa, sb]) {
      expect(s.tableErrors()).toContainEqual({ t: 'error', code: 'table_closed', message: TABLE_CLOSED_BY_CLUB });
      expect(s.out).toContainEqual({ t: 'error', code: 'closed', message: TABLE_CLOSED_BY_CLUB });
    }
    expect(f.clubs.standings(club.code).every((m) => m.matchesPlayed === 0)).toBe(true);
    // An unknown table is a 404.
    expect((await f.call('POST', `/api/clubs/${club.code}/tables/NOPE99/close`, {}, owner.auth)).status).toBe(404);
  });
});

describe('taking a player off a club table', () => {
  it('turns the seat over to the bot, tells the player, and keeps them out of that table', async () => {
    const f = fixture();
    const { owner, club, others } = await clubWith(f, ['Ah-Mei', 'Griefer']);
    const [a, g] = others;
    const table = ((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, a.auth)).json as { code: string }).code;
    const sa = f.socket(a.userId);
    const sg = f.socket(g.userId);
    sa.sit(table);
    sg.sit(table);
    sa.game({ t: 'start' });
    const res = await f.call('POST', `/api/clubs/${club.code}/tables/${table}/evict`, { userId: g.userId }, owner.auth);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ seats: 1 });
    const seat = f.rooms.hostedTable(table)!.seatInfo()[1];
    expect(seat.userId).toBeUndefined();
    expect(seat.name).toMatch(/Bot/);
    expect(sg.tableErrors().map((e) => e.code)).toContain('evicted');
    expect(sg.out).toContainEqual({ t: 'error', code: 'closed', message: EVICTED_BY_CLUB });
    expect(f.rooms.roomPeers(table)).not.toContain(sg.id);
    // Coming back to that table is refused, and the match plays on for the others.
    expect(sg.sit(table)).toMatchObject({ t: 'error', code: 'room_unavailable' });
    expect(f.rooms.hasRoom(table)).toBe(true);
  });

  it('refuses an admin acting on the owner or another admin, and a member acting at all', async () => {
    const f = fixture();
    const { owner, club, others } = await clubWith(f, ['Ada', 'Abe', 'Member']);
    const [ad1, ad2, m] = others;
    await f.call('POST', `/api/clubs/${club.code}/members/${ad1.userId}/role`, { role: 'admin' }, owner.auth);
    await f.call('POST', `/api/clubs/${club.code}/members/${ad2.userId}/role`, { role: 'admin' }, owner.auth);
    const table = ((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, owner.auth)).json as { code: string }).code;
    expect((await f.call('POST', `/api/clubs/${club.code}/tables/${table}/evict`, { userId: owner.userId }, ad1.auth)).status).toBe(403);
    expect((await f.call('POST', `/api/clubs/${club.code}/tables/${table}/evict`, { userId: ad2.userId }, ad1.auth)).status).toBe(403);
    expect((await f.call('POST', `/api/clubs/${club.code}/tables/${table}/evict`, { userId: ad1.userId }, m.auth)).status).toBe(403);
    expect((await f.call('POST', `/api/clubs/${club.code}/tables/${table}/evict`, { userId: m.userId }, ad1.auth)).status).toBe(200);
    expect((await f.call('POST', `/api/clubs/${club.code}/tables/${table}/evict`, { userId: 5 }, owner.auth)).status).toBe(400);
  });
});

describe('removing and banning members', () => {
  it('takes a removed member off the live club tables too, their seats going to the bot', async () => {
    const f = fixture();
    const { owner, club, others } = await clubWith(f, ['Ah-Mei', 'Griefer']);
    const [a, g] = others;
    const table = ((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, a.auth)).json as { code: string }).code;
    const sa = f.socket(a.userId);
    const sg = f.socket(g.userId);
    sa.sit(table);
    sg.sit(table);
    expect(f.rooms.hostedTable(table)!.seatInfo()[1].userId).toBe(g.userId);
    expect((await f.call('DELETE', `/api/clubs/${club.code}/members/${g.userId}`, undefined, owner.auth)).status).toBe(200);
    // In the lobby the seat is simply freed.
    expect(f.rooms.hostedTable(table)!.seatInfo()[1]).toMatchObject({ userId: undefined, name: '' });
    expect(sg.out).toContainEqual({ t: 'error', code: 'closed', message: EVICTED_BY_CLUB });
    // Leaving on your own does not evict anyone.
    expect((await f.call('DELETE', `/api/clubs/${club.code}/members/${a.userId}`, undefined, a.auth)).status).toBe(200);
    expect(f.rooms.hostedTable(table)!.seatInfo()[0].userId).toBe(a.userId);
  });

  it('keeps a banned account out of the club, its requests and its tables until unbanned', async () => {
    const f = fixture();
    const { owner, club, others } = await clubWith(f, ['Griefer', 'Member']);
    const [g, m] = others;
    const table = ((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, owner.auth)).json as { code: string }).code;
    const sg = f.socket(g.userId);
    sg.sit(table);
    const banned = await f.call('POST', `/api/clubs/${club.code}/bans`, { userId: g.userId }, owner.auth);
    expect(banned.status).toBe(200);
    const body = banned.json as unknown as Club;
    expect(body.members.some((x) => x.userId === g.userId)).toBe(false);
    expect(body.bans).toEqual([expect.objectContaining({ userId: g.userId, name: 'Griefer', by: owner.userId })]);
    expect(f.rooms.hostedTable(table)!.seatInfo()[0].userId).not.toBe(g.userId);
    // Cannot rejoin or reapply, even once the club asks for approval.
    const again = await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth);
    expect(again.status).toBe(403);
    expect(again.json.message).toBe('You cannot join this club');
    await f.call('PATCH', `/api/clubs/${club.code}`, { settings: { joinRequiresApproval: true } }, owner.auth);
    expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth)).status).toBe(403);
    expect(f.clubs.club(club.code).pending).toEqual([]);
    // Cannot join the club's tables over the socket.
    const sg2 = f.socket(g.userId);
    expect(sg2.sit(table)).toMatchObject({ t: 'error' });
    // Members do not see the ban list; the owner does.
    expect('bans' in ((await f.call('GET', `/api/clubs/${club.code}`, undefined, m.auth)).json as object)).toBe(false);
    expect(((await f.call('GET', `/api/clubs/${club.code}`, undefined, owner.auth)).json as unknown as Club).bans).toHaveLength(1);
    // A plain member cannot ban or unban; nobody can ban the owner.
    expect((await f.call('POST', `/api/clubs/${club.code}/bans`, { userId: owner.userId }, m.auth)).status).toBe(403);
    expect((await f.call('DELETE', `/api/clubs/${club.code}/bans/${g.userId}`, undefined, m.auth)).status).toBe(403);
    // Unbanned: may ask again.
    expect((await f.call('DELETE', `/api/clubs/${club.code}/bans/${g.userId}`, undefined, owner.auth)).status).toBe(200);
    expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth)).json.status).toBe('pending');
  });

  it('bans an account that only has a pending request, and one outside the club by id', async () => {
    const f = fixture();
    const { owner, club } = await clubWith(f, []);
    await f.call('PATCH', `/api/clubs/${club.code}`, { settings: { joinRequiresApproval: true } }, owner.auth);
    const p = await f.guest('Pending');
    await f.call('POST', `/api/clubs/${club.code}/join`, {}, p.auth);
    expect((await f.call('POST', `/api/clubs/${club.code}/bans`, { userId: p.userId }, owner.auth)).status).toBe(200);
    expect(f.clubs.club(club.code).pending).toEqual([]);
    const stranger = await f.guest('Stranger');
    expect((await f.call('POST', `/api/clubs/${club.code}/bans`, { userId: stranger.userId }, owner.auth)).status).toBe(200);
    expect(f.clubs.isBanned(club.code, stranger.userId)).toBe(true);
    expect((await f.call('POST', `/api/clubs/${club.code}/bans`, { userId: 'not-an-account-at-all' }, owner.auth)).status).toBe(404);
  });

  it('keeps bans across a restart', async () => {
    const f = fixture();
    const { owner, club, others } = await clubWith(f, ['Griefer']);
    await f.call('POST', `/api/clubs/${club.code}/bans`, { userId: others[0].userId }, owner.auth);
    await f.clubs.flush();
    const again = new ClubRegistry({ store: f.repos.clubs });
    await again.load();
    expect(again.isBanned(club.code, others[0].userId)).toBe(true);
  });
});

describe('requests, ownership, leaving and deleting', () => {
  it('rejects a pending request', async () => {
    const f = fixture();
    const { owner, club, others } = await clubWith(f, ['Member']);
    await f.call('PATCH', `/api/clubs/${club.code}`, { settings: { joinRequiresApproval: true } }, owner.auth);
    const p = await f.guest('Pending');
    await f.call('POST', `/api/clubs/${club.code}/join`, {}, p.auth);
    expect((await f.call('POST', `/api/clubs/${club.code}/members/${p.userId}/reject`, {}, others[0].auth)).status).toBe(403);
    const res = await f.call('POST', `/api/clubs/${club.code}/members/${p.userId}/reject`, {}, owner.auth);
    expect(res.status).toBe(200);
    expect((res.json as unknown as Club).pending).toEqual([]);
    expect((await f.call('POST', `/api/clubs/${club.code}/members/${p.userId}/reject`, {}, owner.auth)).status).toBe(404);
    // A rejected player may ask again (only a ban stops that).
    expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, p.auth)).json.status).toBe('pending');
  });

  it('passes the club on and lets the old owner leave', async () => {
    const f = fixture();
    const { owner, club, others } = await clubWith(f, ['Heir']);
    const [heir] = others;
    expect((await f.call('DELETE', `/api/clubs/${club.code}/members/${owner.userId}`, undefined, owner.auth)).status).toBe(403);
    expect((await f.call('POST', `/api/clubs/${club.code}/members/${heir.userId}/role`, { role: 'owner' }, owner.auth)).status).toBe(200);
    expect(f.clubs.club(club.code).ownerId).toBe(heir.userId);
    expect((await f.call('DELETE', `/api/clubs/${club.code}/members/${owner.userId}`, undefined, owner.auth)).status).toBe(200);
    expect(f.clubs.isMember(club.code, owner.userId)).toBe(false);
  });

  it('deletes a club only for its owner with the name typed, and closes its tables', async () => {
    const f = fixture();
    const { owner, club, others } = await clubWith(f, ['Ada']);
    const [admin] = others;
    await f.call('POST', `/api/clubs/${club.code}/members/${admin.userId}/role`, { role: 'admin' }, owner.auth);
    const table = ((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, admin.auth)).json as { code: string }).code;
    const sa = f.socket(admin.userId);
    sa.sit(table);
    expect((await f.call('DELETE', `/api/clubs/${club.code}`, { confirm: 'Tools' }, admin.auth)).status).toBe(403);
    expect((await f.call('DELETE', `/api/clubs/${club.code}`, { confirm: 'Wrong' }, owner.auth)).status).toBe(400);
    expect((await f.call('DELETE', `/api/clubs/${club.code}`, {}, owner.auth)).status).toBe(400);
    expect((await f.call('DELETE', `/api/clubs/${club.code}`, { confirm: ' tools ' }, owner.auth)).status).toBe(204);
    expect(f.rooms.hasRoom(table)).toBe(false);
    expect(sa.out.some((m) => m.t === 'error' && m.code === 'closed')).toBe(true);
    expect((await f.call('GET', `/api/clubs/${club.code}`, undefined, owner.auth)).status).toBe(404);
    await f.clubs.flush();
    expect(await f.repos.clubs.get(club.code)).toBeNull();
  });
});
