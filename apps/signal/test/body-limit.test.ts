/**
 * An oversized request body is answered 413 `too_large` over a real HTTP connection. The handler
 * used to destroy the request mid-upload, so the client saw an empty reply (probe bigbody: curl
 * exit 52); the old unit test's fake response object could not show that.
 */
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionService } from '../src/auth';
import { loadConfig } from '../src/config';
import { createRepos } from '../src/repos';
import { createSignalServer, type SignalServer } from '../src/server';

let server: SignalServer;
let port: number;

beforeAll(async () => {
  const repos = createRepos();
  server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions: new SessionService(repos.repos, { pepper: 'p'.repeat(32) }), providers: {}, config: loadConfig({}), log: () => undefined });
  port = server.address().port;
});
afterAll(() => server.close());

/** POST `bytes` bytes to the guest sign-up over a real socket, streamed in 16 KiB pieces. */
function post(bytes: number): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/auth/guest', headers: { 'content-type': 'application/json', 'content-length': bytes } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += String(d)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    const piece = Buffer.alloc(16 * 1024, 'a');
    let left = bytes;
    const pump = () => {
      while (left > 0) {
        const n = Math.min(left, piece.length);
        left -= n;
        if (!req.write(piece.subarray(0, n))) return void req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

describe('request body limit over HTTP', () => {
  it('answers a body just over 64 KiB with 413 too_large, and keeps serving', async () => {
    const res = await post(70_000);
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toBe('application/json');
    expect(JSON.parse(res.body)).toMatchObject({ error: 'too_large' });
    const ok = await fetch(`http://127.0.0.1:${port}/health`);
    expect(ok.status).toBe(200);
  });

  it('answers a much larger body with 413 too_large too', async () => {
    const res = await post(600_000);
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'too_large' });
  });

  it('still reads a body under the limit', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: { platform: 'ios' }, displayName: 'x'.repeat(60_000) }) });
    expect(res.status).toBe(201);
  });
});
