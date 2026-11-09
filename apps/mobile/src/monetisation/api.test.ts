import { describe, expect, it } from 'vitest';
import type { Authoriser, FetchLike } from '../api/http';
import { clubsApi } from '../api/clubs';
import { walletApi } from '../api/wallet';
import { storeServer } from './server';

/** Records each request and answers 200 with `body`. */
function recorder(body: unknown = {}) {
  const calls: Array<{ method: string; url: string; auth?: string; body?: unknown }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const auth: Authoriser = { token: async () => 'mjs_tok', onUnauthorised: () => undefined };
  return { calls, ctx: { base: 'https://game.example', auth, fetch } };
}

describe('wallet and club routes the store and legal surface call', () => {
  it('POST /api/wallet/spend carries the product and the bearer token', async () => {
    const { calls, ctx } = recorder({ wallet: { diamonds: 0, bonusDiamonds: 0 } });
    await walletApi.spend(ctx, 'theme.jade');
    expect(calls).toEqual([{ method: 'POST', url: 'https://game.example/api/wallet/spend', auth: 'Bearer mjs_tok', body: { productId: 'theme.jade' } }]);
  });

  it('POST /api/clubs/:code/season starts a new season', async () => {
    const { calls, ctx } = recorder({ club: { code: 'AB12', season: 2 } });
    const r = await clubsApi.startSeason(ctx, 'AB 12');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://game.example/api/clubs/AB%2012/season', auth: 'Bearer mjs_tok' });
    expect(r.club?.season).toBe(2);
  });

  it('POST /api/reports sends the report body as built', async () => {
    const { calls, ctx } = recorder({ id: 'r-1' });
    await clubsApi.report(ctx, { reportedUserId: 'u-2', reason: 'abusive_chat', roomCode: 'ROOM1' });
    expect(calls[0]).toEqual({ method: 'POST', url: 'https://game.example/api/reports', auth: 'Bearer mjs_tok', body: { reportedUserId: 'u-2', reason: 'abusive_chat', roomCode: 'ROOM1' } });
  });

  it('POST /api/wallet/sync asks the server to read the store after Restore', async () => {
    const { calls, ctx } = recorder({ synced: true, applied: 1, wallet: { diamonds: 300, bonusDiamonds: 0 } });
    expect((await storeServer.sync(ctx)).applied).toBe(1);
    expect(calls).toEqual([{ method: 'POST', url: 'https://game.example/api/wallet/sync', auth: 'Bearer mjs_tok', body: {} }]);
  });

  it('PATCH /api/me carries the analytics choice', async () => {
    const { calls, ctx } = recorder({ user: { id: 'u-1' } });
    await storeServer.sendAnalyticsConsent(ctx, false);
    expect(calls).toEqual([{ method: 'PATCH', url: 'https://game.example/api/me', auth: 'Bearer mjs_tok', body: { analyticsConsent: false } }]);
  });
});
