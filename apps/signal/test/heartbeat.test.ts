/**
 * The client heartbeat over a real server: the server answers `{t:'ping'}` with `{t:'pong'}`, and a
 * client behind a link that silently stops carrying packets (a network handover, a NAT that
 * forgot the connection) notices and reports the link closed (probe E: the session stayed
 * "connected" for over 100 s while the server had long dropped it).
 */
import { createServer, connect, type Socket as TcpSocket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SignalingClient, HEARTBEAT_CLOSE_CODE, type WebSocketLike } from '@mjm/net';
import { WebSocket } from 'ws';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createRepos } from '../src/repos';
import { createSignalServer, type SignalServer } from '../src/server';

let server: SignalServer | null = null;
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  await server?.close();
  server = null;
});

async function boot() {
  const repos = createRepos();
  server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions: new SessionService(repos.repos, { pepper: 'p'.repeat(32) }), providers: {}, config: loadConfig({}), log: () => undefined });
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: { platform: 'ios' } }) });
  const token = ((await res.json()) as { session: { token: string } }).session.token;
  return { port, token };
}

describe('client heartbeat against the server', () => {
  it('answers a ping with a pong', async () => {
    const { port, token } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    cleanups.push(() => ws.terminate());
    const frames: Array<{ t: string }> = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d)) as { t: string }));
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(JSON.stringify({ t: 'hello', auth: token }));
    ws.send(JSON.stringify({ t: 'ping' }));
    const deadline = Date.now() + 3_000;
    while (frames.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    // The pong does not wait for the session check to finish.
    expect(frames.map((f) => f.t).sort()).toEqual(['hello', 'pong']);
  });

  it('keeps a link that answers and closes one that has gone silent', async () => {
    const { port, token } = await boot();
    let blackHole = false;
    const sockets = new Set<TcpSocket>();
    // Between the client and the server: forwards until told to swallow everything, and never reports a close.
    const proxy = createServer((client) => {
      const upstream = connect(port, '127.0.0.1');
      sockets.add(client).add(upstream);
      client.on('data', (d) => !blackHole && upstream.write(d));
      upstream.on('data', (d) => !blackHole && client.write(d));
      client.on('error', () => undefined);
      upstream.on('error', () => undefined);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => {
      for (const s of sockets) s.destroy();
      proxy.close();
    });
    const via = `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const sig = new SignalingClient(via, { auth: token, webSocket: (u) => new WebSocket(u) as unknown as WebSocketLike, heartbeatMs: 100, pongTimeoutMs: 150 });
    let closedAt = 0;
    sig.onClose(() => (closedAt = Date.now()));
    await sig.connect();
    cleanups.push(() => sig.close());
    // Several heartbeats go by with answers: the link stays up.
    await new Promise((r) => setTimeout(r, 600));
    expect(closedAt).toBe(0);
    blackHole = true;
    const t0 = Date.now();
    while (closedAt === 0 && Date.now() - t0 < 3_000) await new Promise((r) => setTimeout(r, 10));
    expect(closedAt).toBeGreaterThan(0);
    // Within one interval plus the pong timeout (25 s with the defaults).
    expect(closedAt - t0).toBeLessThan(600);
    expect(sig.lastCloseCode).toBe(HEARTBEAT_CLOSE_CODE);
  });
});
