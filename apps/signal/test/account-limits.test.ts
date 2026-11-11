/**
 * Create and join allowances follow the account and the client address, not the socket, and one
 * account can hold only a few unfinished tables: reconnecting in a loop used to fill the whole
 * server (probe squat2: one guest token reached MAX_HOSTED_TABLES in eight seconds).
 */
import { describe, expect, it } from 'vitest';
import type { Club } from '../src/clubs';
import { LIMITS } from '../src/config';
import { createMemoryRepos } from '../src/repos';
import { TablePersister } from '../src/persist';
import {
  CREATE_COOLDOWN,
  JOIN_THROTTLED,
  RoomLimitError,
  RoomRegistry,
  TABLE_CAP,
  TABLE_CAP_CODE,
  type RoomRegistryOptions,
  type Socket,
} from '../src/rooms';

import { apiFixture } from './helpers';

type Out = { t: string; code?: string; message?: string; room?: string };

function setup(opts: RoomRegistryOptions = {}) {
  const clock = { now: 0 };
  const reg = new RoomRegistry({ allowHosted: true, botDelayMs: 0, now: () => clock.now, ...opts });
  /** A fresh socket for `userId` from `ip`, as the socket layer opens one after a verified hello. */
  const socket = (userId: string, ip = '203.0.113.1') => {
    const out: Out[] = [];
    const s: Socket = { send: (j) => out.push(JSON.parse(j) as Out), close: () => undefined };
    const id = reg.hello(reg.connect(s, ip), userId);
    return { id, out, last: () => out[out.length - 1] };
  };
  return { reg, clock, socket };
}

describe('per-account and per-address create and join allowances', () => {
  it('does not refill the create allowance when the same account reconnects', () => {
    const { reg, clock, socket } = setup();
    const first = socket('user-a');
    reg.handle(first.id, { t: 'create', hosted: true });
    expect(first.last()!.t).toBe('room');
    reg.disconnect(first.id);
    // A new socket for the same account inside the cooldown gets the cooldown, not a table.
    clock.now += 1_000;
    const again = socket('user-a');
    reg.handle(again.id, { t: 'create', hosted: true });
    expect(again.last()).toEqual({ t: 'error', message: CREATE_COOLDOWN });
    clock.now += 9_000;
    reg.handle(again.id, { t: 'create', hosted: true });
    expect(again.last()!.t).toBe('room');
  });

  it('limits creates from one address across many accounts', () => {
    const { reg, clock, socket } = setup();
    let made = 0;
    for (let i = 0; i < 20; i++) {
      const s = socket(`guest-${i}`);
      reg.handle(s.id, { t: 'create', hosted: true });
      if (s.last()!.t === 'room') made++;
    }
    expect(made).toBe(6);
    // Another address is not affected, and the address's allowance comes back over the minute.
    const elsewhere = socket('guest-x', '198.51.100.7');
    reg.handle(elsewhere.id, { t: 'create', hosted: true });
    expect(elsewhere.last()!.t).toBe('room');
    clock.now += 10_000;
    const later = socket('guest-y');
    reg.handle(later.id, { t: 'create', hosted: true });
    expect(later.last()!.t).toBe('room');
  });

  it('does not refill the join allowance when the same account reconnects', () => {
    const { reg, socket } = setup();
    let throttled = 0;
    for (let round = 0; round < 3; round++) {
      const s = socket('guesser');
      for (let i = 0; i < 5; i++) {
        reg.handle(s.id, { t: 'join', room: `GUES${round}${i}` });
        if (s.last()!.message === JOIN_THROTTLED) throttled++;
      }
      reg.disconnect(s.id);
    }
    // Five guesses per ten seconds in all, not five per socket.
    expect(throttled).toBe(10);
  });

  it('limits join attempts from one address across many accounts', () => {
    const { reg, socket } = setup();
    let answered = 0;
    for (let i = 0; i < 40; i++) {
      const s = socket(`guest-${i}`);
      reg.handle(s.id, { t: 'join', room: `NOPE${i}` });
      if (s.last()!.message !== JOIN_THROTTLED) answered++;
    }
    expect(answered).toBe(20);
  });
});

describe('a spent allowance, asked before the session is checked again', () => {
  it('refuses a join or create whose allowance is spent with the usual message, and takes nothing itself', () => {
    const { reg, clock, socket } = setup();
    const s = socket('user-a');
    // Asking takes nothing: after any number of questions the whole allowance is still there.
    for (let i = 0; i < 50; i++) expect(reg.throttled(s.id, { t: 'join', room: 'NOPE00' })).toBe(false);
    expect(s.out.filter((m) => m.t === 'error')).toEqual([]);
    for (let i = 0; i < 5; i++) {
      reg.handle(s.id, { t: 'join', room: `NOPE0${i}` });
      expect(s.last()!.code).toBe('room_unavailable');
    }
    const before = s.out.length;
    expect(reg.throttled(s.id, { t: 'join', room: 'NOPE99' })).toBe(true);
    expect(s.out.slice(before)).toEqual([{ t: 'error', message: JOIN_THROTTLED }]);
    // The same account on a new socket shares the allowance; another account at another address does not.
    expect(reg.throttled(socket('user-a').id, { t: 'join', room: 'NOPE99' })).toBe(true);
    expect(reg.throttled(socket('user-b', '198.51.100.9').id, { t: 'join', room: 'NOPE99' })).toBe(false);
    clock.now += 2_000;
    expect(reg.throttled(s.id, { t: 'join', room: 'NOPE99' })).toBe(false);

    expect(reg.throttled(s.id, { t: 'create', hosted: true })).toBe(false);
    reg.handle(s.id, { t: 'create', hosted: true });
    expect(s.last()!.t).toBe('room');
    expect(reg.throttled(s.id, { t: 'create', hosted: true })).toBe(true);
    expect(s.last()).toEqual({ t: 'error', message: CREATE_COOLDOWN });
    clock.now += 10_000;
    expect(reg.throttled(s.id, { t: 'create', hosted: true })).toBe(false);
  });

  it('refuses when the address has no allowance left, whatever the account', () => {
    const { reg, socket } = setup();
    for (let i = 0; i < 20; i++) reg.handle(socket(`guest-${i}`).id, { t: 'join', room: `NOPE${i}` });
    const fresh = socket('guest-fresh');
    expect(reg.throttled(fresh.id, { t: 'join', room: 'NOPE99' })).toBe(true);
    expect(fresh.last()).toEqual({ t: 'error', message: JOIN_THROTTLED });
    expect(reg.throttled(socket('guest-elsewhere', '198.51.100.9').id, { t: 'join', room: 'NOPE99' })).toBe(false);
  });

  it('leaves a create that would be refused for another reason to the usual path, so its reply stays the same', () => {
    const { reg, clock, socket } = setup({ maxTablesPerUser: 1 });
    const s = socket('user-a');
    reg.handle(s.id, { t: 'create', hosted: true });
    expect(s.last()!.t).toBe('room');
    // Inside the cooldown and at the table cap: the cap is the answer, as before.
    clock.now += 1_000;
    const before = s.out.length;
    expect(reg.throttled(s.id, { t: 'create', hosted: true })).toBe(false);
    expect(s.out.length).toBe(before);
    reg.handle(s.id, { t: 'create', hosted: true });
    expect(s.last()).toEqual({ t: 'error', code: TABLE_CAP_CODE, message: TABLE_CAP });
    // A club's answer comes first too, and a relay-only room where none are allowed.
    expect(reg.throttled(s.id, { t: 'create', club: 'CLUB01' })).toBe(false);
    expect(reg.throttled(s.id, { t: 'create' })).toBe(false);
    // Frames that need no allowance are never throttled.
    expect(reg.throttled(s.id, { t: 'leave' })).toBe(false);
    expect(reg.throttled('nobody', { t: 'join', room: 'NOPE00' })).toBe(false);
  });

  it('refuses a queue request whose join allowance is spent with the queue code', () => {
    const { reg, socket } = setup({ queue: { enqueue: () => undefined, leave: () => undefined } });
    const s = socket('user-a');
    expect(reg.throttled(s.id, { t: 'queue' })).toBe(false);
    for (let i = 0; i < 5; i++) reg.handle(s.id, { t: 'join', room: `NOPE0${i}` });
    expect(reg.throttled(s.id, { t: 'queue' })).toBe(true);
    expect(s.last()).toMatchObject({ t: 'queue_error', code: 'rate_limited' });
  });
});

describe('open tables per account', () => {
  it('refuses a fourth unfinished table to one account over the socket, and frees a place when one closes', () => {
    const { reg, clock, socket } = setup();
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = socket('owner', `203.0.113.${i + 10}`);
      reg.handle(s.id, { t: 'create', hosted: true });
      expect(s.last()!.t).toBe('room');
      codes.push(s.last()!.room!);
      // Sit down with three bots and deal, so the table outlives the socket.
      for (const msg of [{ t: 'join', name: 'Owner' }, { t: 'add_bot' }, { t: 'add_bot' }, { t: 'add_bot' }, { t: 'start' }]) {
        reg.handle(s.id, { t: 'to', to: `server-${codes[i]}`, data: { ch: 'game', msg } });
      }
      reg.disconnect(s.id);
      clock.now += 10_000;
    }
    expect(reg.openTablesOf('owner')).toBe(3);
    const fourth = socket('owner', '203.0.113.50');
    reg.handle(fourth.id, { t: 'create', hosted: true });
    expect(fourth.last()).toEqual({ t: 'error', code: TABLE_CAP_CODE, message: TABLE_CAP });
    // The refusal does not spend the create allowance, and another account is unaffected.
    const other = socket('someone-else', '203.0.113.51');
    reg.handle(other.id, { t: 'create', hosted: true });
    expect(other.last()!.t).toBe('room');
    reg.closeRoomByCode(codes[0]);
    reg.handle(fourth.id, { t: 'create', hosted: true });
    expect(fourth.last()!.t).toBe('room');
  });

  it('applies the same cap to tables opened through the API, but never to a restored table', () => {
    const { reg } = setup({ maxTablesPerUser: 2 });
    const a = reg.createHostedRoom({ createdBy: 'owner' });
    reg.createHostedRoom({ createdBy: 'owner' });
    expect(() => reg.createHostedRoom({ createdBy: 'owner' })).toThrow(RoomLimitError);
    expect(() => reg.createHostedRoom({ createdBy: 'owner' })).toThrow(TABLE_CAP);
    // Tables opened with no account (the old API path) are not counted against anyone.
    reg.createHostedRoom();
    const snapshot = reg.hostedTable(a)!.serialize();
    reg.closeRoomByCode(a);
    reg.createHostedRoom({ createdBy: 'owner' });
    // A restart restores every table its owner had, even past the cap.
    expect(reg.createHostedRoom({ restore: snapshot, createdBy: 'owner' })).toBe(a);
    expect(reg.openTablesOf('owner')).toBe(3);
  });

  it('keeps the creator through a snapshot, so restored tables still count towards the cap', async () => {
    const repo = createMemoryRepos().tableSnapshots;
    const first = setup({ maxTablesPerUser: 2 });
    const persister = new TablePersister(first.reg, repo, { log: () => undefined });
    persister.start();
    first.reg.createHostedRoom({ createdBy: 'owner' });
    first.reg.createHostedRoom({ createdBy: 'owner' });
    await persister.flush();
    persister.stop();
    const stored = await repo.listActive();
    expect(stored.map((s) => (s.snapshot as { createdBy?: string }).createdBy)).toEqual(['owner', 'owner']);

    const next = setup({ maxTablesPerUser: 2 });
    await new TablePersister(next.reg, repo, { log: () => undefined }).restore();
    expect(next.reg.openTablesOf('owner')).toBe(2);
    expect(() => next.reg.createHostedRoom({ createdBy: 'owner' })).toThrow(TABLE_CAP);
  });
});

describe('a club table opened over the API is charged like a create over the socket', () => {
  function fixture(rooms: RoomRegistryOptions = {}) {
    const clock = { now: Date.UTC(2026, 10, 11) };
    const f = apiFixture({ now: () => clock.now, rooms: { botDelayMs: 0, ...rooms } });
    const club = async (owner: { auth: Record<string, string> }, name: string) => (await f.call('POST', '/api/clubs', { name }, owner.auth)).json as unknown as Club;
    const open = (code: string, who: { auth: Record<string, string> }, ip?: string) => f.call('POST', `/api/clubs/${code}/tables`, {}, who.auth, ip);
    return { ...f, clock, club, open };
  }

  it('allows one table per account every ten seconds and answers 429 in between, opening nothing', async () => {
    const f = fixture();
    const owner = await f.guest('Owner');
    const club = await f.club(owner, 'Friday');
    expect((await f.open(club.code, owner)).status).toBe(200);
    const again = await f.open(club.code, owner);
    expect(again.status).toBe(429);
    expect(again.json.error).toBe('rate_limited');
    expect(again.headers['retry-after']).toBe('12');
    expect(f.rooms.stats().hostedTables).toBe(1);
    expect(f.clubs.club(club.code).tables).toHaveLength(1);
    // It is the same allowance a socket create spends, in both directions.
    const out: Out[] = [];
    const peer = f.rooms.hello(f.rooms.connect({ send: (j) => out.push(JSON.parse(j) as Out), close: () => undefined }, '203.0.113.50'), owner.userId);
    f.rooms.handle(peer, { t: 'create', hosted: true });
    expect(out[out.length - 1]).toEqual({ t: 'error', message: CREATE_COOLDOWN });
    f.clock.now += LIMITS.createCooldownMs;
    f.rooms.handle(peer, { t: 'create', hosted: true });
    expect(out[out.length - 1].t).toBe('room');
    expect((await f.open(club.code, owner)).status).toBe(429);
    f.clock.now += LIMITS.createCooldownMs;
    expect((await f.open(club.code, owner)).status).toBe(200);
  });

  it('allows six tables a minute from one address, whatever the accounts', async () => {
    const f = fixture();
    const ip = '203.0.113.7';
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.createsPerIpPerMinute + 2; i++) {
      const owner = await f.guest(`Owner ${i}`);
      statuses.push((await f.open((await f.club(owner, `Club ${i}`)).code, owner, ip)).status);
    }
    expect(statuses).toEqual([...Array<number>(LIMITS.createsPerIpPerMinute).fill(200), 429, 429]);
    expect(f.rooms.stats().hostedTables).toBe(LIMITS.createsPerIpPerMinute);
    // Another address is not affected, and the first one's allowance comes back over the minute.
    const elsewhere = await f.guest('Elsewhere');
    expect((await f.open((await f.club(elsewhere, 'Elsewhere')).code, elsewhere, '198.51.100.9')).status).toBe(200);
    f.clock.now += 10_000;
    const later = await f.guest('Later');
    expect((await f.open((await f.club(later, 'Later')).code, later, ip)).status).toBe(200);
  });

  it('does not charge a table that is refused for another reason', async () => {
    const f = fixture({ maxTablesPerUser: 1, maxHostedTables: 2 });
    const owner = await f.guest('Owner');
    const member = await f.guest('Member');
    const club = await f.club(owner, 'Closed shop');
    await f.call('PATCH', `/api/clubs/${club.code}`, { settings: { membersCanOpenTables: false } }, owner.auth);
    await f.call('POST', `/api/clubs/${club.code}/join`, {}, member.auth);
    // Not allowed by the club: 403, and the member's allowance is untouched.
    expect((await f.open(club.code, member)).status).toBe(403);
    expect(f.rooms.chargeCreate(member.userId)).toBe(true);
    // At the account's table cap: the cap is the answer, also inside the cooldown, and it costs nothing.
    expect((await f.open(club.code, owner)).status).toBe(200);
    const capped = await f.open(club.code, owner);
    expect(capped.status).toBe(503);
    expect(capped.json.message).toBe(TABLE_CAP);
    // A full server likewise.
    f.rooms.createHostedRoom();
    const other = await f.guest('Other');
    const full = await f.open((await f.club(other, 'Other')).code, other);
    expect(full.status).toBe(503);
    f.rooms.closeRoomByCode(f.rooms.hostedRooms()[1]);
    expect((await f.open(f.clubs.clubsForUser(other.userId)[0].code, other)).status).toBe(200);
  });
});
