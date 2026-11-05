import { describe, expect, it } from 'vitest';
import type { Authoriser, FetchLike } from '../api/http';
import { clubsApi } from '../api/clubs';
import { walletApi } from '../api/wallet';

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
  it('POST /api/wallet/spend carries the product, an idempotency id and the bearer token', async () => {
    const { calls, ctx } = recorder({ wallet: { diamonds: 0, bonusDiamonds: 0 } });
    await walletApi.spend(ctx, 'theme.jade', 'req-1');
    expect(calls).toEqual([{ method: 'POST', url: 'https://game.example/api/wallet/spend', auth: 'Bearer mjs_tok', body: { productId: 'theme.jade', requestId: 'req-1' } }]);
  });

  it('POST /api/clubs/:code/season starts a new season', async () => {
    const { calls, ctx } = recorder({ code: 'AB12', season: 2 });
    const club = await clubsApi.startSeason(ctx, 'AB 12');
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://game.example/api/clubs/AB%2012/season', auth: 'Bearer mjs_tok' });
    expect(club.season).toBe(2);
  });

  it('POST /api/reports sends the report body as built', async () => {
    const { calls, ctx } = recorder({ id: 'r-1' });
    await clubsApi.report(ctx, { reportedUserId: 'u-2', reason: 'abuse', roomCode: 'ROOM1' });
    expect(calls[0]).toEqual({ method: 'POST', url: 'https://game.example/api/reports', auth: 'Bearer mjs_tok', body: { reportedUserId: 'u-2', reason: 'abuse', roomCode: 'ROOM1' } });
  });
});
