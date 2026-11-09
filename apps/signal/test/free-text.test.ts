/**
 * Every piece of free text a player sends is cleaned before it is stored or shown: club names,
 * descriptions and table labels, display names, report details, guest sign-up fields, seat names
 * and chat. One NUL in a table label or seat name used to stop a whole club (and a hosted table)
 * being saved in Postgres (probe nul2), and a cut by UTF-16 units split emoji (probe emoji).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createApiHandler, memberIdentity } from '../src/api';
import { SessionService } from '../src/auth';
import { ClubRegistry } from '../src/clubs';
import { createPool, type Pool } from '../src/db';
import { cleanField } from '../src/limits';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, type Repos, type UserRecord } from '../src/repos';
import { RoomRegistry, type Socket } from '../src/rooms';
import { apiFixture, PEPPER, request } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const NUL = '\u0000';
const RLO = '\u202E';
const ZWSP = '\u200B';
const GRIN = '\u{1F600}';

/** No C0 control, bidi override or zero-width space, and no lone surrogate half. */
function isClean(s: string): boolean {
  const wellFormed = (x: string) => Buffer.from(x, 'utf8').toString('utf8') === x;
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u202A-\u202E\u2066-\u2069\u200B]/.test(s) && wellFormed(s);
}

describe('cleanField', () => {
  it('strips controls and invisible characters and never splits an emoji at the limit', () => {
    expect(cleanField(`  gg${NUL}${RLO}${ZWSP} `, 40)).toBe('gg');
    expect(cleanField('a'.repeat(39) + GRIN, 40)).toBe('a'.repeat(39));
    expect(cleanField('b'.repeat(23) + GRIN, 24)).toBe('b'.repeat(23));
    expect(cleanField(GRIN.repeat(30), 24)).toBe(GRIN.repeat(12));
    expect(cleanField(`${NUL}${ZWSP}`, 24)).toBe('');
    expect(cleanField(7, 24)).toBe('');
    expect(cleanField('line one\n\n\n\nline two', 100, { multiline: true })).toBe('line one\n\nline two');
    expect(cleanField('line one\nline two', 100)).toBe('line one line two');
  });
});

describe('club text fields', () => {
  const owner = { userId: 'user-owner-1', name: 'Owner' };
  const setup = () => new ClubRegistry({ store: createMemoryRepos().clubs });

  it('cleans club names, descriptions and table labels', () => {
    const clubs = setup();
    const club = clubs.createClub(owner, `Tea${NUL} House${RLO}`);
    expect(club.name).toBe('Tea House');
    const updated = clubs.update(club.code, owner.userId, { name: `New${ZWSP} name`, description: `Fridays${NUL}\n\n\n\nbring snacks` });
    expect(updated.name).toBe('New name');
    expect(updated.description).toBe('Fridays\n\nbring snacks');
    const table = clubs.addTable(club.code, owner.userId, { code: 'TABLE1', label: 'a'.repeat(39) + GRIN });
    expect(table.label).toBe('a'.repeat(39));
    const blank = clubs.addTable(club.code, owner.userId, { code: 'TABLE2', label: `${NUL}${ZWSP}` });
    expect(blank.label).toBe("Owner's table");
  });

  it('refuses a club name that cleans to nothing, as an empty one', () => {
    const clubs = setup();
    expect(() => clubs.createClub(owner, `${NUL}${ZWSP} `)).toThrow('Club name is required');
    const club = clubs.createClub(owner, 'Kept');
    expect(clubs.update(club.code, owner.userId, { name: `${ZWSP}` }).name).toBe('Kept');
  });
});

describe('account text fields over the API', () => {
  it('cleans the display name on PATCH /api/me and falls back to a placeholder when nothing is left', async () => {
    const { call, guest } = apiFixture();
    const g = await guest();
    const res = await call('PATCH', '/api/me', { displayName: `Kai${NUL} Lin${RLO}` }, g.auth);
    expect(res.status).toBe(200);
    expect((res.json.user as { displayName: string }).displayName).toBe('Kai Lin');
    const blank = await call('PATCH', '/api/me', { displayName: `${NUL}${ZWSP}` }, g.auth);
    expect(blank.status).toBe(200);
    const user = blank.json.user as UserRecord & { createdAt: string };
    expect(user.displayName).toBe('');
    expect(memberIdentity({ ...user, createdAt: 0 } as unknown as UserRecord).name).toMatch(/^Player [0-9A-F]{4}$/);
  });

  it('cleans what the guest sign-up stores', async () => {
    const { call, repos } = apiFixture();
    const res = await call('POST', '/api/auth/guest', { device: { id: randomUUID(), platform: `ios${NUL}`, appBuild: `1${RLO}`, locale: 'en' }, displayName: `Mei${NUL}`, avatar: `gent${ZWSP}` });
    expect(res.status).toBe(201);
    const user = (await repos.users.get(res.json.userId as string))!;
    expect(user.displayName).toBe('Mei');
    expect(user.avatar).toBe('gent');
    const [device] = await repos.devices.listForUser(user.id);
    expect(device.platform).toBe('ios');
    expect(device.appBuild).toBe('1');
  });

  it('cleans report details and keeps their line breaks', async () => {
    const { call, guest, repos } = apiFixture();
    const a = await guest();
    const b = await guest();
    const res = await call('POST', '/api/reports', { reportedUserId: b.userId, reason: 'other', details: `kept ${NUL}stalling\n\n\n\nevery turn${RLO}` }, a.auth);
    expect(res.status).toBe(201);
    const [report] = await repos.reports.listAbout(b.userId);
    expect(report.details).toBe('kept stalling\n\nevery turn');
    // Details that clean to nothing are stored as none.
    await call('POST', '/api/reports', { reportedUserId: a.userId, reason: 'other', details: `${ZWSP}${NUL}` }, b.auth);
    expect((await repos.reports.listAbout(a.userId))[0].details).toBeNull();
  });
});

describe('seat names and chat at a hosted table', () => {
  function seatAt(reg: RoomRegistry, userId: string | undefined, name: string | undefined, join: Record<string, unknown>) {
    const out: Array<{ t: string; room?: string; data?: { msg?: { t?: string; text?: string } } }> = [];
    const s: Socket = { send: (j) => out.push(JSON.parse(j)), close: () => undefined };
    const id = userId ? reg.hello(reg.connect(s), userId, undefined, name) : reg.handle(reg.connect(s), { t: 'hello' });
    return { id, out, join };
  }

  it("seats a player under the account's display name, and cleans a name the client chose", () => {
    const reg = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const code = reg.createHostedRoom();
    const named = seatAt(reg, 'user-named-1', `Ah-Mei${NUL}`, {});
    reg.handle(named.id, { t: 'join', room: code });
    reg.handle(named.id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg: { t: 'join', name: 'Somebody Else' } } });
    const anon = seatAt(reg, 'user-noname-1', `${ZWSP}`, {});
    reg.handle(anon.id, { t: 'join', room: code });
    reg.handle(anon.id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg: { t: 'join', name: `Seat${NUL}${RLO}`, avatar: `gent${NUL}` } } });
    const emoji = seatAt(reg, 'user-emoji-1', undefined, {});
    reg.handle(emoji.id, { t: 'join', room: code });
    reg.handle(emoji.id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg: { t: 'join', name: 'b'.repeat(23) + GRIN } } });
    const seats = reg.hostedTable(code)!.seatInfo();
    expect(seats.map((s) => s.name)).toEqual(['Ah-Mei', 'Seat', 'b'.repeat(23), '']);
    expect(seats[1].avatar).toBe('gent');
    // A renamed account sits down under its new name next time.
    reg.setPeerName(anon.id, 'Bo');
    reg.handle(anon.id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg: { t: 'leave' } } });
    reg.handle(anon.id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg: { t: 'join', name: 'ignored' } } });
    expect(reg.hostedTable(code)!.seatInfo().some((s) => s.name === 'Bo')).toBe(true);
    const snapshot = JSON.stringify(reg.hostedTable(code)!.serialize());
    expect(isClean(snapshot)).toBe(true);
  });

  it('cleans chat lines and drops one that cleans to nothing', () => {
    const reg = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const code = reg.createHostedRoom();
    const p = seatAt(reg, 'user-chatty-1', 'Chatty', {});
    reg.handle(p.id, { t: 'join', room: code });
    const to = (msg: Record<string, unknown>) => reg.handle(p.id, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg } });
    to({ t: 'join', name: 'Chatty' });
    const chats = () => p.out.filter((m) => m.data?.msg?.t === 'chat').map((m) => m.data!.msg!.text);
    to({ t: 'chat', text: `hi${NUL}${RLO} there` });
    to({ t: 'chat', text: `${NUL}${ZWSP}` });
    expect(chats()).toEqual(['hi there']);
  });
});

describe.skipIf(!PG_URL)('free text against Postgres', () => {
  let admin: Pool;
  let pool: Pool;
  let repos: Repos;
  const schema = 'mjm_text_' + randomHex(6);

  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => undefined });
    repos = createPgRepos(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin?.end();
  });

  it('answers PATCH /api/me with a NUL in the name with the cleaned name, never a 500', async () => {
    const sessions = new SessionService(repos, { pepper: PEPPER });
    const handler = createApiHandler({ clubs: new ClubRegistry({ store: repos.clubs }), rooms: new RoomRegistry({ allowHosted: true }), repos, sessions });
    const signup = await request(handler, 'POST', '/api/auth/guest', { device: { id: randomUUID(), platform: 'ios', appBuild: '1', locale: 'en' }, displayName: `Mei${NUL}` });
    expect(signup.status).toBe(201);
    const auth = { authorization: `Bearer ${(signup.json.session as { token: string }).token}` };
    const res = await request(handler, 'PATCH', '/api/me', { displayName: `Kai${NUL} Lin`, avatar: `gent${NUL}` }, auth);
    expect(res.status).toBe(200);
    expect(res.json.user).toMatchObject({ displayName: 'Kai Lin', avatar: 'gent' });
    expect((await repos.users.get(signup.json.userId as string))!.displayName).toBe('Kai Lin');
  });

  it('stores a cleaned display name, club and table snapshot without a database error', async () => {
    const id = randomUUID();
    await repos.users.create({ id, kind: 'guest', displayName: cleanField(`Mei${NUL}`, 24), createdAt: Date.now() });
    expect((await repos.users.get(id))!.displayName).toBe('Mei');
    const clubs = new ClubRegistry({ store: repos.clubs });
    const club = clubs.createClub({ userId: id, name: 'Mei' }, `Tea${NUL} House`);
    clubs.addTable(club.code, id, { code: 'NULTB1', label: `gg${NUL}` });
    clubs.update(club.code, id, { description: `desc${NUL}` });
    await clubs.flush();
    const stored = (await repos.clubs.get(club.code))!;
    expect(stored.name).toBe('Tea House');
    expect(stored.description).toBe('desc');
    expect(stored.tables.map((t) => t.label)).toEqual(['gg']);

    const reg = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const code = reg.createHostedRoom();
    const s: Socket = { send: () => undefined, close: () => undefined };
    const peer = reg.hello(reg.connect(s), id, undefined, undefined);
    reg.handle(peer, { t: 'join', room: code });
    reg.handle(peer, { t: 'to', to: `server-${code}`, data: { ch: 'game', msg: { t: 'join', name: `Seat${NUL}` } } });
    await repos.tableSnapshots.save({ roomCode: code, clubCode: null, status: 'open', snapshot: reg.hostedTable(code)!.serialize(), updatedAt: Date.now() });
    expect(((await repos.tableSnapshots.get(code))!.snapshot as { seats: Array<{ name: string }> }).seats[0].name).toBe('Seat');
  });
});
