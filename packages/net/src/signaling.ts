/**
 * Signaling / relay client over WebSocket. Used for two things:
 *   1. exchanging WebRTC offers/answers/ICE candidates between peers, and
 *   2. relaying game messages when a direct data channel cannot be established.
 *
 * The protocol is tiny and documented in apps/signal/README.md.
 */
import type { Transport, Unsubscribe } from './transport';

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ServerMessage =
  | { t: 'hello'; peerId: string }
  | { t: 'room'; room: string; peers: string[]; host: string }
  | { t: 'peer'; peerId: string; event: 'join' | 'leave' }
  | { t: 'from'; from: string; data: unknown }
  | { t: 'error'; message: string };

export type ClientToServer =
  | { t: 'hello' }
  | { t: 'create'; room?: string }
  | { t: 'join'; room: string }
  | { t: 'to'; to: string; data: unknown }
  | { t: 'leave' };

export interface RoomInfo {
  room: string;
  peers: string[];
  host: string;
}

export class SignalingClient {
  peerId: string | null = null;
  room: RoomInfo | null = null;
  private ws: WebSocketLike | null = null;
  private readonly msgHandlers = new Set<(m: ServerMessage) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private closedLocally = false;
  private pendingHello: Array<(id: string) => void> = [];
  private pendingRoom: Array<{ resolve: (r: RoomInfo) => void; reject: (e: Error) => void }> = [];

  constructor(
    private readonly url: string,
    private readonly makeSocket: WebSocketFactory = (u) => new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(u),
  ) {}

  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = this.makeSocket(this.url);
      this.ws = ws;
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello' } satisfies ClientToServer));
      ws.onerror = () => reject(new Error('Signaling connection failed'));
      ws.onclose = () => {
        this.ws = null;
        if (!this.closedLocally) for (const h of this.closeHandlers) h();
        for (const p of this.pendingRoom) p.reject(new Error('Connection closed'));
        this.pendingRoom = [];
      };
      ws.onmessage = (ev) => {
        let m: ServerMessage;
        try {
          m = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        if (m.t === 'hello') {
          this.peerId = m.peerId;
          for (const p of this.pendingHello) p(m.peerId);
          this.pendingHello = [];
          resolve(m.peerId);
        } else if (m.t === 'room') {
          this.room = { room: m.room, peers: m.peers, host: m.host };
          const p = this.pendingRoom.shift();
          p?.resolve(this.room);
        } else if (m.t === 'error') {
          const p = this.pendingRoom.shift();
          p?.reject(new Error(m.message));
        } else if (m.t === 'peer' && this.room) {
          if (m.event === 'join' && !this.room.peers.includes(m.peerId)) this.room.peers.push(m.peerId);
          if (m.event === 'leave') this.room.peers = this.room.peers.filter((p) => p !== m.peerId);
        }
        for (const h of this.msgHandlers) h(m);
      };
    });
  }

  createRoom(room?: string): Promise<RoomInfo> {
    return this.roomRequest({ t: 'create', room });
  }

  joinRoom(room: string): Promise<RoomInfo> {
    return this.roomRequest({ t: 'join', room: room.toUpperCase() });
  }

  private roomRequest(msg: ClientToServer): Promise<RoomInfo> {
    return new Promise((resolve, reject) => {
      if (!this.ws) return reject(new Error('Not connected'));
      this.pendingRoom.push({ resolve, reject });
      this.ws.send(JSON.stringify(msg));
    });
  }

  sendTo(to: string, data: unknown): void {
    this.ws?.send(JSON.stringify({ t: 'to', to, data } satisfies ClientToServer));
  }

  onMessage(cb: (m: ServerMessage) => void): Unsubscribe {
    this.msgHandlers.add(cb);
    return () => this.msgHandlers.delete(cb);
  }

  onClose(cb: () => void): Unsubscribe {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  close(): void {
    this.closedLocally = true;
    try {
      this.ws?.send(JSON.stringify({ t: 'leave' } satisfies ClientToServer));
    } catch {
      /* already closed */
    }
    this.ws?.close();
    this.ws = null;
  }
}

/** Transport that relays every message through the signaling server. Always works; higher latency than WebRTC. */
export class RelayTransport implements Transport {
  private readonly msgHandlers = new Set<(from: string, msg: unknown) => void>();
  private readonly peerHandlers = new Set<(peerId: string, event: 'join' | 'leave') => void>();
  private readonly unsub: Unsubscribe;

  constructor(
    private readonly signaling: SignalingClient,
    /** Channel tag so WebRTC signaling and game traffic can share one socket. */
    private readonly channel = 'game',
  ) {
    this.unsub = signaling.onMessage((m) => {
      if (m.t === 'from') {
        const env = m.data as { ch?: string; msg?: unknown };
        if (env && env.ch === this.channel) for (const h of this.msgHandlers) h(m.from, env.msg);
      } else if (m.t === 'peer') {
        for (const h of this.peerHandlers) h(m.peerId, m.event);
      }
    });
  }

  get id(): string {
    return this.signaling.peerId ?? '';
  }
  send(to: string, msg: unknown): void {
    this.signaling.sendTo(to, { ch: this.channel, msg });
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
    return (this.signaling.room?.peers ?? []).filter((p) => p !== this.id);
  }
  onClose(cb: () => void): Unsubscribe {
    return this.signaling.onClose(cb);
  }
  close(): void {
    this.unsub();
    this.signaling.close();
  }
}
