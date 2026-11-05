/**
 * Creates a playable table session: either fully local (this device hosts and
 * plays against bots, offline) or online (the game server hosts the table and
 * every player, this device included, verifies each hand).
 */
import { type BotSkill, type RuleSet } from '@mjm/engine';
import { LoopbackHub, RelayTransport, SignalingClient, TableClient, TableHost, transportLink, type RoomInfo, type SerializedHost } from '@mjm/net';

export interface Session {
  client: TableClient;
  /** Present only for local play, where this device runs the table. */
  host: TableHost | null;
  roomCode: string;
  mode: 'local' | 'online';
  transportKind: 'loopback' | 'relay';
  /** Online only: the game server this table lives on (a resume must go back to it). */
  serverUrl?: string;
  clubCode?: string;
  close(): void;
}

export interface LocalOptions {
  botSkill?: BotSkill;
  /** Resume a saved table. */
  restore?: { host: SerializedHost; token: string };
}

export function createLocalSession(name: string, avatar: string, rules: RuleSet, opts: LocalOptions = {}): Session {
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), {
    roomCode: 'LOCAL',
    rules,
    botDelayMs: 650,
    intermissionSeconds: 600,
    botSkill: opts.botSkill,
    restore: opts.restore?.host,
  });
  const client = new TableClient(host.localLink('me'), name, avatar, { token: opts.restore?.token });
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

export interface OnlineOptions {
  signalUrl: string;
  name: string;
  avatar: string;
  userId?: string;
  rules: RuleSet;
  /** 'create' asks the game server for a new table; 'join' joins one by code. */
  action: 'create' | 'join';
  code?: string;
  botSkill?: BotSkill;
  /** Rejoin token from a previous session at this table. */
  token?: string;
  clubCode?: string;
}

/**
 * Asks the game server to host a new table with these rules. The only place that
 * reaches past the public SignalingClient API; swap the body for
 * `signaling.createHostedRoom(rules, botSkill)` once that method exists.
 */
export function requestHostedRoom(signaling: SignalingClient, rules: RuleSet, botSkill: BotSkill | undefined): Promise<RoomInfo> {
  return signaling.createHostedRoom(rules, botSkill);
}

export async function createOnlineSession(opts: OnlineOptions): Promise<Session> {
  const signaling = new SignalingClient(opts.signalUrl);
  await signaling.connect();
  try {
    const transport = new RelayTransport(signaling, 'game');
    const room = opts.action === 'create' ? await requestHostedRoom(signaling, opts.rules, opts.botSkill) : await signaling.joinRoom(opts.code ?? '');
    const client = new TableClient(transportLink(transport, room.host), opts.name, opts.avatar, { token: opts.token, userId: opts.userId });
    client.join();
    return {
      client,
      host: null,
      roomCode: room.room,
      mode: 'online',
      transportKind: 'relay',
      serverUrl: opts.signalUrl,
      clubCode: opts.clubCode,
      // Leaving closes the relay transport, which closes the signalling socket.
      close: () => client.leave(),
    };
  } catch (e) {
    signaling.close();
    throw e;
  }
}
