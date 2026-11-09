/**
 * Table controllers on the game server: at a club table only its opener and the club's owner and
 * admins add bots and start; at a private hosted table only its creator. Other seated players get
 * `not_controller`.
 */
import { describe, expect, it } from 'vitest';
import { ClubRegistry, clubGate } from '../src/clubs';
import { RoomRegistry, type Socket } from '../src/rooms';

type Frame = { t: string; room?: string; host?: string; data?: { ch?: string; msg?: { t: string; code?: string } } };

function peerAs(rooms: RoomRegistry, userId: string) {
  const out: Frame[] = [];
  const socket: Socket = { send: (j) => out.push(JSON.parse(j) as Frame), close: () => undefined };
  const id = rooms.hello(rooms.connect(socket), userId);
  let host = '';
  const p = {
    id,
    out,
    join(room: string) {
      rooms.handle(id, { t: 'join', room });
      p.sit();
    },
    /** Sit down at the room this peer is in (after its create or join). */
    sit() {
      host = out.filter((m) => m.t === 'room').pop()!.host!;
      p.game({ t: 'join', name: userId });
    },
    game(msg: unknown) {
      rooms.handle(id, { t: 'to', to: host, data: { ch: 'game', msg } });
    },
    codes: () => out.filter((m) => m.t === 'from' && m.data?.msg?.t === 'error').map((m) => m.data!.msg!.code),
  };
  return p;
}

const owner = { userId: 'user-owner-1', name: 'Owner' };
const opener = { userId: 'user-opener-2', name: 'Opener' };
const member = { userId: 'user-member-3', name: 'Member' };

describe('club table controllers', () => {
  it("lets the opener and the club's admins add bots and start, and refuses other members", () => {
    const clubs = new ClubRegistry();
    const rooms = new RoomRegistry({ allowHosted: true, clubs: clubGate(clubs), botDelayMs: 0 });
    const club = clubs.createClub(owner, 'Ctl');
    clubs.joinClub(club.code, opener);
    clubs.joinClub(club.code, member);
    const code = rooms.createHostedRoom({ clubCode: club.code, createdBy: opener.userId });
    clubs.addTable(club.code, opener.userId, { code });
    const o = peerAs(rooms, opener.userId);
    const m = peerAs(rooms, member.userId);
    o.join(code);
    m.join(code);
    const host = rooms.hostedTable(code)!;
    m.game({ t: 'add_bot' });
    m.game({ t: 'start' });
    expect(m.codes()).toEqual(['not_controller', 'not_controller']);
    expect(host.seatInfo().some((s) => s.isBot)).toBe(false);
    o.game({ t: 'add_bot' });
    expect(host.seatInfo().filter((s) => s.isBot)).toHaveLength(1);
    // Promoting the member to admin takes effect at the table at once.
    clubs.setRole(club.code, owner.userId, member.userId, 'admin');
    m.game({ t: 'add_bot' });
    expect(host.seatInfo().filter((s) => s.isBot)).toHaveLength(2);
    expect(m.codes()).toEqual(['not_controller', 'not_controller']);
  });

  it('lets the club owner control a table someone else opened', () => {
    const clubs = new ClubRegistry();
    const rooms = new RoomRegistry({ allowHosted: true, clubs: clubGate(clubs), botDelayMs: 0 });
    const club = clubs.createClub(owner, 'Ctl');
    clubs.joinClub(club.code, opener);
    const code = rooms.createHostedRoom({ clubCode: club.code, createdBy: opener.userId });
    const o = peerAs(rooms, opener.userId);
    const w = peerAs(rooms, owner.userId);
    o.join(code);
    w.join(code);
    w.game({ t: 'start' });
    expect(w.codes()).toEqual([]);
    expect(rooms.hostedTable(code)!.phase).not.toBe('lobby');
  });
});

describe('private table controllers', () => {
  it('lets only the creator of a private hosted table add bots and start', () => {
    const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 0 });
    const creator = peerAs(rooms, 'user-creator-1');
    rooms.handle(creator.id, { t: 'create', hosted: true });
    const code = creator.out.find((m) => m.t === 'room')!.room!;
    creator.sit();
    const friend = peerAs(rooms, 'user-friend-2');
    friend.join(code);
    friend.game({ t: 'start' });
    expect(friend.codes()).toEqual(['not_controller']);
    expect(rooms.hostedTable(code)!.phase).toBe('lobby');
    creator.game({ t: 'start' });
    expect(rooms.hostedTable(code)!.phase).not.toBe('lobby');
  });
});
