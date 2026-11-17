/**
 * Transport abstraction. Everything above this line is transport-agnostic:
 * the same host and client code runs over the WebSocket relay to the game
 * server, or the in-memory loopback used for tests and offline play.
 */
export type Unsubscribe = () => void;

/**
 * The text of one frame as it came off the wire, parsed, or null when it is not JSON at all (an
 * empty body, the text `undefined`, a truncated frame): the receiver drops such a frame without
 * throwing. Any JSON value comes back as is; what reads it checks its shape.
 */
export function parseWire(text: unknown): { value: unknown } | null {
  if (typeof text !== 'string') return null;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return null;
  }
}

/** Whether `v` can be a protocol frame: a plain object (not null, not an array) with a string `t`. */
export function isFrame(v: unknown): v is { t: string } & Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { t?: unknown }).t === 'string';
}

export interface Transport {
  /** Stable id of this peer within the room. */
  readonly id: string;
  send(to: string, msg: unknown): void;
  onMessage(cb: (from: string, msg: unknown) => void): Unsubscribe;
  onPeer(cb: (peerId: string, event: 'join' | 'leave') => void): Unsubscribe;
  peers(): string[];
  close(): void;
  /** Fires once when the underlying connection is lost (not on local close()). */
  onClose?(cb: () => void): Unsubscribe;
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
    // Serialise like a real wire: a value JSON has no text for goes out as the text a socket would send
    // (`undefined`), and a body that does not parse is dropped by the receiver, as on a real link.
    const wire = parseWire(JSON.stringify(msg) ?? String(msg));
    if (!wire) return;
    const payload = wire.value;
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
