/**
 * Transport abstraction. Everything above this line is transport-agnostic:
 * the same host and client code runs over WebRTC data channels, a WebSocket
 * relay, or the in-memory loopback used for tests and offline play.
 */
export type Unsubscribe = () => void;

export interface Transport {
  /** Stable id of this peer within the room. */
  readonly id: string;
  send(to: string, msg: unknown): void;
  onMessage(cb: (from: string, msg: unknown) => void): Unsubscribe;
  onPeer(cb: (peerId: string, event: 'join' | 'leave') => void): Unsubscribe;
  peers(): string[];
  close(): void;
}

/** In-memory hub: all transports created from it can talk to each other synchronously or with a delay. */
export class LoopbackHub {
  private readonly nodes = new Map<string, LoopbackTransport>();
  constructor(private readonly latencyMs = 0) {}

  create(id: string): LoopbackTransport {
    const t = new LoopbackTransport(id, this);
    for (const other of this.nodes.values()) other.emitPeer(id, 'join');
    this.nodes.set(id, t);
    return t;
  }

  /** @internal */
  deliver(from: string, to: string, msg: unknown): void {
    const target = this.nodes.get(to);
    if (!target) return;
    const payload = JSON.parse(JSON.stringify(msg)) as unknown; // force serialisation like a real wire
    if (this.latencyMs > 0) setTimeout(() => target.emitMessage(from, payload), this.latencyMs);
    else target.emitMessage(from, payload);
  }

  /** @internal */
  remove(id: string): void {
    this.nodes.delete(id);
    for (const other of this.nodes.values()) other.emitPeer(id, 'leave');
  }

  ids(): string[] {
    return [...this.nodes.keys()];
  }
}

export class LoopbackTransport implements Transport {
  private readonly msgHandlers = new Set<(from: string, msg: unknown) => void>();
  private readonly peerHandlers = new Set<(peerId: string, event: 'join' | 'leave') => void>();
  constructor(
    public readonly id: string,
    private readonly hub: LoopbackHub,
  ) {}
  send(to: string, msg: unknown): void {
    this.hub.deliver(this.id, to, msg);
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
    return this.hub.ids().filter((x) => x !== this.id);
  }
  close(): void {
    this.hub.remove(this.id);
  }
  /** @internal */
  emitMessage(from: string, msg: unknown): void {
    for (const h of this.msgHandlers) h(from, msg);
  }
  /** @internal */
  emitPeer(id: string, ev: 'join' | 'leave'): void {
    for (const h of this.peerHandlers) h(id, ev);
  }
}
