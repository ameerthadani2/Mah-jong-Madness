/**
 * Creates a playable table session: either fully local (this device hosts and
 * plays against bots) or online (this device hosts for friends, or joins a
 * host — another phone or a neutral server).
 */
import { type RuleSet } from '@mjm/engine';
import {
  LoopbackHub,
  RelayTransport,
  SignalingClient,
  TableClient,
  TableHost,
  WebRTCTransport,
  transportLink,
  type PeerConnectionFactory,
  type Transport,
} from '@mjm/net';

export interface Session {
  client: TableClient;
  /** Present when this device is the host. */
  host: TableHost | null;
  roomCode: string;
  mode: 'local' | 'host' | 'guest';
  transportKind: 'loopback' | 'relay' | 'webrtc';
  close(): void;
}

export function createLocalSession(name: string, avatar: string, rules: RuleSet): Session {
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), { roomCode: 'LOCAL', rules, botDelayMs: 650, intermissionSeconds: 600 });
  const client = new TableClient(host.localLink('me'), name, avatar);
  client.join();
  return {
    client,
    host,
    roomCode: 'LOCAL',
    mode: 'local',
    transportKind: 'loopback',
    close: () => {
      client.leave();
      host.close();
    },
  };
}

let registeredFactory: PeerConnectionFactory | null = null;

/**
 * Register a WebRTC implementation for direct peer-to-peer data channels.
 * In a dev-client / EAS build with `react-native-webrtc` installed, call this
 * once at startup (see index.js):
 *
 *   import { RTCPeerConnection } from 'react-native-webrtc';
 *   registerPeerConnectionFactory((cfg) => new RTCPeerConnection(cfg));
 *
 * Without it (e.g. Expo Go) the app falls back to the relay transport, which
 * works everywhere at the cost of a hop through the signaling server.
 */
export function registerPeerConnectionFactory(factory: PeerConnectionFactory): void {
  registeredFactory = factory;
}

/** Find a WebRTC implementation: a registered factory, or the browser global on web. */
function findPeerConnection(): PeerConnectionFactory | null {
  if (registeredFactory) return registeredFactory;
  const g = globalThis as unknown as { RTCPeerConnection?: new (cfg: unknown) => unknown };
  if (typeof g.RTCPeerConnection === 'function') {
    const Ctor = g.RTCPeerConnection;
    return (cfg) => new Ctor(cfg) as ReturnType<PeerConnectionFactory>;
  }
  return null;
}

export interface OnlineOptions {
  signalUrl: string;
  name: string;
  avatar: string;
  rules: RuleSet;
  /** 'create' hosts a new table; 'join' joins by code. */
  action: 'create' | 'join';
  code?: string;
  /** Ask the signaling server to host the table as a neutral party. */
  hostedByServer?: boolean;
  preferWebRTC?: boolean;
}

export async function createOnlineSession(opts: OnlineOptions): Promise<Session> {
  const signaling = new SignalingClient(opts.signalUrl);
  await signaling.connect();
  const pcFactory = opts.preferWebRTC === false ? null : findPeerConnection();
  const transport: Transport = pcFactory ? new WebRTCTransport(signaling, pcFactory) : new RelayTransport(signaling, 'game');
  const transportKind = pcFactory ? 'webrtc' : 'relay';

  if (opts.action === 'create') {
    const room = await (opts.hostedByServer
      ? (signaling as unknown as { roomRequest: (m: unknown) => Promise<{ room: string; host: string }> }).roomRequest({ t: 'create', hosted: true, rules: opts.rules })
      : signaling.createRoom());
    if (opts.hostedByServer) {
      const client = new TableClient(transportLink(transport, room.host), opts.name, opts.avatar);
      client.join();
      return { client, host: null, roomCode: room.room, mode: 'guest', transportKind, close: () => client.leave() };
    }
    const host = new TableHost(transport, { roomCode: room.room, rules: opts.rules, botDelayMs: 650 });
    const client = new TableClient(host.localLink('me'), opts.name, opts.avatar);
    client.join();
    return {
      client,
      host,
      roomCode: room.room,
      mode: 'host',
      transportKind,
      close: () => {
        client.leave();
        host.close();
      },
    };
  }

  const room = await signaling.joinRoom(opts.code ?? '');
  if (transport instanceof WebRTCTransport) void transport.connectAll();
  const client = new TableClient(transportLink(transport, room.host), opts.name, opts.avatar);
  client.join();
  return { client, host: null, roomCode: room.room, mode: 'guest', transportKind, close: () => client.leave() };
}
