/**
 * Room registry and message routing, independent of the WebSocket layer so it
 * can be unit-tested. Rooms are identified by short codes players can read out
 * loud (PokerBros-style club/table codes).
 */
import { TableHost, type HostEvent, type Transport, type Unsubscribe } from '@mjm/net';
import { withRules, type BotSkill, type RuleSet } from '@mjm/engine';

export interface Socket {
  send(json: string): void;
  close(): void;
}

export type Inbound =
  | { t: 'hello' }
  | { t: 'create'; room?: string; hosted?: boolean; rules?: Partial<RuleSet>; botSkill?: BotSkill }
  | { t: 'join'; room: string }
  | { t: 'to'; to: string; data: unknown }
  | { t: 'leave' };

interface Peer {
  id: string;
  socket: Socket;
  room: string | null;
}

interface Room {
  code: string;
  host: string;
  peers: Set<string>;
  createdAt: number;
  /** Present when the server itself hosts the table (neutral host mode). */
  table?: { host: TableHost; transport: ServerTransport };
  /** Rooms created through the API stay alive without peers until this time. */
  keepAliveUntil?: number;
}

export interface RoomEvent {
  room: string;
  event: HostEvent;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomRegistry {
  private readonly peers = new Map<string, Peer>();
  private readonly rooms = new Map<string, Room>();
  private readonly eventHandlers = new Set<(ev: RoomEvent) => void>();
  constructor(
    private readonly opts: { allowHosted?: boolean; now?: () => number; random?: () => number } = {},
  ) {}

  /** Subscribe to events from server-hosted tables (for club standings). */
  onRoomEvent(cb: (ev: RoomEvent) => void): () => void {
    this.eventHandlers.add(cb);
    return () => this.eventHandlers.delete(cb);
  }

  /** Create a server-hosted room with no peers yet (e.g. a club table opened from the API). */
  createHostedRoom(opts: { code?: string; rules?: Partial<RuleSet>; botSkill?: BotSkill; keepAliveMs?: number } = {}): string {
    if (!this.opts.allowHosted) throw new Error('Hosted tables are disabled');
    const code = opts.code && /^[A-Z0-9]{4,8}$/.test(opts.code) && !this.rooms.has(opts.code) ? opts.code : this.newCode();
    const room: Room = { code, host: '', peers: new Set(), createdAt: this.now(), keepAliveUntil: this.now() + (opts.keepAliveMs ?? 15 * 60_000) };
    this.attachTable(room, opts.rules ?? {}, opts.botSkill);
    this.rooms.set(code, room);
    return code;
  }

  private attachTable(room: Room, rules: Partial<RuleSet>, botSkill?: BotSkill): void {
    const transport = new ServerTransport(this, room.code, `server-${room.code}`);
    const host = new TableHost(transport, { roomCode: room.code, rules: withRules(rules), botDelayMs: 600, botSkill });
    host.onEvent((event) => {
      for (const h of this.eventHandlers) h({ room: room.code, event });
    });
    room.table = { host, transport };
    room.host = transport.id;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  newCode(len = 6): string {
    const rnd = this.opts.random ?? Math.random;
    for (;;) {
      let code = '';
      for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(rnd() * ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  connect(socket: Socket): string {
    const id = `tmp-${Math.random().toString(36).slice(2, 10)}`;
    this.peers.set(id, { id, socket, room: null });
    return id;
  }

  /** Handle one inbound message from the peer currently known as `peerId`. Returns the (possibly renamed) peer id. */
  handle(peerId: string, msg: Inbound): string {
    const peer = this.peers.get(peerId);
    if (!peer) return peerId;
    switch (msg.t) {
      case 'hello': {
        // Ids are always server-assigned and never change for the life of the socket, so a peer cannot
        // impersonate a departed player or the server-side host ('server-…') by choosing its own id.
        if (!peerId.startsWith('tmp-')) {
          peer.socket.send(JSON.stringify({ t: 'hello', peerId }));
          return peerId;
        }
        let id = `p-${Math.random().toString(36).slice(2, 12)}`;
        while (this.peers.has(id)) id = `p-${Math.random().toString(36).slice(2, 12)}`;
        this.peers.delete(peerId);
        peer.id = id;
        this.peers.set(id, peer);
        peer.socket.send(JSON.stringify({ t: 'hello', peerId: id }));
        return id;
      }
      case 'create': {
        if (peer.id.startsWith('tmp-')) return peer.id;
        this.leave(peer);
        const code = msg.room && /^[A-Z0-9]{4,8}$/.test(msg.room) && !this.rooms.has(msg.room) ? msg.room : this.newCode();
        const room: Room = { code, host: peer.id, peers: new Set([peer.id]), createdAt: this.now() };
        if (msg.hosted && this.opts.allowHosted) this.attachTable(room, msg.rules ?? {}, msg.botSkill);
        this.rooms.set(code, room);
        peer.room = code;
        this.sendRoom(peer, room);
        return peer.id;
      }
      case 'join': {
        if (peer.id.startsWith('tmp-') || typeof msg.room !== 'string') return peer.id;
        const room = this.rooms.get(msg.room.toUpperCase());
        if (!room) {
          peer.socket.send(JSON.stringify({ t: 'error', message: 'Room not found' }));
          return peer.id;
        }
        if (room.peers.size >= 12) {
          peer.socket.send(JSON.stringify({ t: 'error', message: 'Room is full' }));
          return peer.id;
        }
        this.leave(peer);
        room.peers.add(peer.id);
        peer.room = room.code;
        this.sendRoom(peer, room);
        this.broadcast(room, { t: 'peer', peerId: peer.id, event: 'join' }, peer.id);
        return peer.id;
      }
      case 'to': {
        const room = peer.room ? this.rooms.get(peer.room) : undefined;
        if (!room || typeof msg.to !== 'string') return peer.id;
        const to = msg.to;
        if (room.table && to === room.table.transport.id) {
          room.table.transport.receive(peer.id, msg.data);
          return peer.id;
        }
        if (!room.peers.has(to)) return peer.id;
        this.peers.get(to)?.socket.send(JSON.stringify({ t: 'from', from: peer.id, data: msg.data }));
        return peer.id;
      }
      case 'leave':
        this.leave(peer);
        return peer.id;
      default:
        return peer.id;
    }
  }

  disconnect(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.leave(peer);
    this.peers.delete(peerId);
  }

  private leave(peer: Peer): void {
    if (!peer.room) return;
    const room = this.rooms.get(peer.room);
    peer.room = null;
    if (!room) return;
    room.peers.delete(peer.id);
    this.broadcast(room, { t: 'peer', peerId: peer.id, event: 'leave' });
    room.table?.transport.peerLeft(peer.id);
    if (room.peers.size === 0) {
      if (room.keepAliveUntil !== undefined && room.keepAliveUntil > this.now()) {
        // Club table: give players time to come back (the host pauses the match for them).
        room.keepAliveUntil = this.now() + 15 * 60_000;
      } else this.closeRoom(room);
    } else if (room.host === peer.id) {
      room.host = [...room.peers][0];
      this.broadcast(room, { t: 'room', room: room.code, peers: [...room.peers], host: room.host });
    }
  }

  private sendRoom(peer: Peer, room: Room): void {
    const peers = [...room.peers];
    if (room.table) peers.push(room.table.transport.id);
    peer.socket.send(JSON.stringify({ t: 'room', room: room.code, peers, host: room.host }));
  }

  /** @internal */
  broadcast(room: Room, msg: unknown, except?: string): void {
    const json = JSON.stringify(msg);
    for (const id of room.peers) if (id !== except) this.peers.get(id)?.socket.send(json);
  }

  /** @internal used by ServerTransport */
  sendFromServer(roomCode: string, serverId: string, to: string, data: unknown): void {
    const room = this.rooms.get(roomCode);
    if (!room || !room.peers.has(to)) return;
    this.peers.get(to)?.socket.send(JSON.stringify({ t: 'from', from: serverId, data: { ch: 'game', msg: data } }));
  }

  roomPeers(code: string): string[] {
    return [...(this.rooms.get(code)?.peers ?? [])];
  }

  stats(): { peers: number; rooms: number; hostedTables: number } {
    let hosted = 0;
    for (const r of this.rooms.values()) if (r.table) hosted++;
    return { peers: this.peers.size, rooms: this.rooms.size, hostedTables: hosted };
  }

  private closeRoom(room: Room): void {
    room.table?.host.close();
    this.rooms.delete(room.code);
    for (const h of this.eventHandlers) h({ room: room.code, event: { type: 'match_over', roomCode: room.code, matchId: room.table?.host.matchId ?? '', seats: room.table?.host.seatInfo() ?? [], scores: room.table?.host.match().scores ?? [], handNumber: -1 } });
  }

  /** Drive hosted tables' timers and expire abandoned API-created rooms. */
  tick(): void {
    for (const r of [...this.rooms.values()]) {
      r.table?.host.tick();
      if (r.peers.size === 0 && r.keepAliveUntil !== undefined && r.keepAliveUntil <= this.now()) this.closeRoom(r);
    }
  }

  hasRoom(code: string): boolean {
    return this.rooms.has(code.toUpperCase());
  }

  closeRoomByCode(code: string): void {
    const room = this.rooms.get(code.toUpperCase());
    if (room) this.closeRoom(room);
  }

  hostedTable(code: string): TableHost | undefined {
    return this.rooms.get(code)?.table?.host;
  }
}

/** Transport for a table hosted by the server itself: a virtual peer inside the room. */
export class ServerTransport implements Transport {
  private readonly msgHandlers = new Set<(from: string, msg: unknown) => void>();
  private readonly peerHandlers = new Set<(peerId: string, event: 'join' | 'leave') => void>();
  constructor(
    private readonly registry: RoomRegistry,
    private readonly roomCode: string,
    public readonly id: string,
  ) {}
  send(to: string, msg: unknown): void {
    this.registry.sendFromServer(this.roomCode, this.id, to, msg);
  }
  onMessage(cb: (from: string, msg: unknown) => void): Unsubscribe {
    this.msgHandlers.add(cb);
    return () => this.msgHandlers.delete(cb);
  }
  onPeer(cb: (peerId: string, event: 'join' | 'leave') => void): Unsubscribe {
    this.peerHandlers.add(cb);
    return () => this.peerHandlers.delete(cb);
  }
  peers(): string[] {
    return this.registry.roomPeers(this.roomCode);
  }
  close(): void {
    this.msgHandlers.clear();
    this.peerHandlers.clear();
  }
  /** @internal */
  receive(from: string, data: unknown): void {
    const env = data as { ch?: string; msg?: unknown };
    if (!env || typeof env !== 'object' || env.ch !== 'game') return;
    for (const h of this.msgHandlers) {
      try {
        h(from, env.msg);
      } catch {
        /* a misbehaving peer must not break the table for others */
      }
    }
  }
  /** @internal */
  peerLeft(peerId: string): void {
    for (const h of this.peerHandlers) h(peerId, 'leave');
  }
}
