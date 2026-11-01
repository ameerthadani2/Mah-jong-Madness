/**
 * WebRTC data-channel transport with automatic relay fallback.
 *
 * The RTCPeerConnection implementation is injected so the same code runs in a
 * browser (`window.RTCPeerConnection`) and in React Native (`react-native-webrtc`).
 * Peers are connected in a full mesh; the host talks to everyone, clients only
 * need the host. Until a channel is open — or if it never opens — messages go
 * through the relay so play is never blocked by NAT traversal.
 */
import { RelayTransport, SignalingClient } from './signaling';
import type { Transport, Unsubscribe } from './transport';

export interface DataChannelLike {
  readyState: string;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface SessionDescriptionLike {
  type: string;
  sdp?: string;
}

export interface PeerConnectionLike {
  createDataChannel(label: string, opts?: { ordered?: boolean }): DataChannelLike;
  createOffer(): Promise<SessionDescriptionLike>;
  createAnswer(): Promise<SessionDescriptionLike>;
  setLocalDescription(desc: SessionDescriptionLike): Promise<void>;
  setRemoteDescription(desc: SessionDescriptionLike): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
  onicecandidate: ((ev: { candidate: unknown }) => void) | null;
  ondatachannel: ((ev: { channel: DataChannelLike }) => void) | null;
  onconnectionstatechange: ((ev: unknown) => void) | null;
  connectionState?: string;
}

export type PeerConnectionFactory = (config: { iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }> }) => PeerConnectionLike;

export interface WebRTCOptions {
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>;
  /** Milliseconds to wait for a data channel before settling on relay for that peer. */
  connectTimeoutMs?: number;
}

type Signal = { kind: 'offer'; sdp: SessionDescriptionLike } | { kind: 'answer'; sdp: SessionDescriptionLike } | { kind: 'ice'; candidate: unknown };

interface PeerLink {
  pc: PeerConnectionLike;
  channel: DataChannelLike | null;
  open: boolean;
}

export class WebRTCTransport implements Transport {
  private readonly relay: RelayTransport;
  private readonly signalRelay: RelayTransport;
  private readonly links = new Map<string, PeerLink>();
  private readonly msgHandlers = new Set<(from: string, msg: unknown) => void>();
  private readonly unsubs: Unsubscribe[] = [];
  private readonly iceServers: WebRTCOptions['iceServers'];
  private readonly connectTimeoutMs: number;
  /** Per-peer: true when we are using a direct channel. */
  readonly direct = new Map<string, boolean>();

  constructor(
    private readonly signaling: SignalingClient,
    private readonly makePeerConnection: PeerConnectionFactory,
    opts: WebRTCOptions = {},
  ) {
    this.relay = new RelayTransport(signaling, 'game');
    this.signalRelay = new RelayTransport(signaling, 'rtc');
    this.iceServers = opts.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }];
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 8000;
    this.unsubs.push(this.relay.onMessage((from, msg) => this.emit(from, msg)));
    this.unsubs.push(this.signalRelay.onMessage((from, msg) => void this.onSignal(from, msg as Signal)));
    this.unsubs.push(
      this.relay.onPeer((peerId, ev) => {
        if (ev === 'join') void this.connectTo(peerId);
        else this.dropPeer(peerId);
      }),
    );
  }

  get id(): string {
    return this.relay.id;
  }

  /** Start direct connections to every peer already in the room (the newcomer initiates). */
  async connectAll(): Promise<void> {
    await Promise.all(this.relay.peers().map((p) => this.connectTo(p)));
  }

  private link(peerId: string): PeerLink {
    let l = this.links.get(peerId);
    if (l) return l;
    const pc = this.makePeerConnection({ iceServers: this.iceServers ?? [] });
    l = { pc, channel: null, open: false };
    this.links.set(peerId, l);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.signalRelay.send(peerId, { kind: 'ice', candidate: ev.candidate } satisfies Signal);
    };
    pc.ondatachannel = (ev) => this.attachChannel(peerId, ev.channel);
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === 'failed' || st === 'closed' || st === 'disconnected') this.markRelay(peerId);
    };
    return l;
  }

  private attachChannel(peerId: string, ch: DataChannelLike): void {
    const l = this.link(peerId);
    l.channel = ch;
    ch.onopen = () => {
      l.open = true;
      this.direct.set(peerId, true);
    };
    ch.onclose = () => this.markRelay(peerId);
    ch.onmessage = (ev) => {
      try {
        this.emit(peerId, JSON.parse(String(ev.data)));
      } catch {
        /* ignore malformed */
      }
    };
  }

  private markRelay(peerId: string): void {
    const l = this.links.get(peerId);
    if (l) l.open = false;
    this.direct.set(peerId, false);
  }

  /** Initiate an offer to `peerId`. Only the lexically smaller id initiates to avoid glare. */
  private async connectTo(peerId: string): Promise<void> {
    if (this.id > peerId) return;
    const l = this.link(peerId);
    if (l.channel) return;
    this.attachChannel(peerId, l.pc.createDataChannel('mjm', { ordered: true }));
    try {
      const offer = await l.pc.createOffer();
      await l.pc.setLocalDescription(offer);
      this.signalRelay.send(peerId, { kind: 'offer', sdp: offer } satisfies Signal);
    } catch {
      this.markRelay(peerId);
    }
    setTimeout(() => {
      if (!l.open) this.markRelay(peerId);
    }, this.connectTimeoutMs);
  }

  private async onSignal(from: string, sig: Signal): Promise<void> {
    const l = this.link(from);
    try {
      if (sig.kind === 'offer') {
        await l.pc.setRemoteDescription(sig.sdp);
        const answer = await l.pc.createAnswer();
        await l.pc.setLocalDescription(answer);
        this.signalRelay.send(from, { kind: 'answer', sdp: answer } satisfies Signal);
      } else if (sig.kind === 'answer') {
        await l.pc.setRemoteDescription(sig.sdp);
      } else if (sig.kind === 'ice') {
        await l.pc.addIceCandidate(sig.candidate);
      }
    } catch {
      this.markRelay(from);
    }
  }

  private dropPeer(peerId: string): void {
    const l = this.links.get(peerId);
    if (l) {
      try {
        l.channel?.close();
        l.pc.close();
      } catch {
        /* noop */
      }
    }
    this.links.delete(peerId);
    this.direct.delete(peerId);
  }

  private emit(from: string, msg: unknown): void {
    for (const h of this.msgHandlers) h(from, msg);
  }

  send(to: string, msg: unknown): void {
    const l = this.links.get(to);
    if (l && l.open && l.channel && l.channel.readyState === 'open') {
      try {
        l.channel.send(JSON.stringify(msg));
        return;
      } catch {
        this.markRelay(to);
      }
    }
    this.relay.send(to, msg);
  }

  onMessage(cb: (from: string, msg: unknown) => void): Unsubscribe {
    this.msgHandlers.add(cb);
    return () => this.msgHandlers.delete(cb);
  }

  onPeer(cb: (peerId: string, event: 'join' | 'leave') => void): Unsubscribe {
    return this.relay.onPeer(cb);
  }

  peers(): string[] {
    return this.relay.peers();
  }

  close(): void {
    for (const u of this.unsubs) u();
    for (const id of [...this.links.keys()]) this.dropPeer(id);
    this.signalRelay.close();
    this.relay.close();
    this.signaling.close();
  }
}
