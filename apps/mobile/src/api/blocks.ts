/**
 * Blocking a player (docs/API.md, "Blocks"): `GET /api/blocks`, `POST /api/blocks {userId}`,
 * `DELETE /api/blocks/:userId`. A blocked player's chat lines and emotes are hidden at the table
 * (`hideBlocked`), and quick match never seats the two together (the server sees to that).
 *
 * The blocked ids live in one small store for the whole app, loaded once a session exists and
 * updated by each block, so the table hides a player the moment they are blocked.
 */
import { useEffect, useState } from 'react';
import { authorisedJson, globalFetch, type Authoriser, type FetchLike } from './http';

export interface BlocksContext {
  base: string;
  auth: Authoriser;
  fetch?: FetchLike;
}

export interface BlockedPlayer {
  userId: string;
  displayName: string;
  avatar: string | null;
  createdAt: string;
}

export const BLOCKS_REQUEST_TIMEOUT_MS = 15_000;

const request = <T>(ctx: BlocksContext, method: string, path: string, body?: unknown) =>
  authorisedJson<T>(ctx.auth, { fetch: ctx.fetch ?? globalFetch, base: ctx.base, method, path, body, timeoutMs: BLOCKS_REQUEST_TIMEOUT_MS, scope: 'auth', label: 'game server' });

export const blocksApi = {
  list: async (ctx: BlocksContext) => (await request<{ blocks: BlockedPlayer[] }>(ctx, 'GET', '/api/blocks')).blocks,
  /** Errors: `invalid` (400, yourself), `not_found` (404), `limit` (409). Blocking twice is fine. */
  add: (ctx: BlocksContext, userId: string) => request<BlockedPlayer>(ctx, 'POST', '/api/blocks', { userId }),
  remove: (ctx: BlocksContext, userId: string) => request<unknown>(ctx, 'DELETE', `/api/blocks/${encodeURIComponent(userId)}`),
};

// ---------------------------------------------------------------------------------------------

type Listener = (ids: ReadonlySet<string>) => void;

/** The accounts this player has blocked, shared by every screen. */
export class BlockedStore {
  private ids: ReadonlySet<string> = new Set();
  private readonly listeners = new Set<Listener>();
  private loading: Promise<void> | null = null;
  private loadedFor: string | null = null;

  get(): ReadonlySet<string> {
    return this.ids;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private set(ids: Iterable<string>): void {
    this.ids = new Set(ids);
    for (const l of this.listeners) l(this.ids);
  }

  /** Load the list for this account (once; again after `forget` or a different account). Failures leave the list as it was. */
  load(ctx: BlocksContext, userId: string): Promise<void> {
    if (this.loadedFor === userId) return this.loading ?? Promise.resolve();
    this.loadedFor = userId;
    this.loading = blocksApi.list(ctx).then(
      (list) => {
        if (this.loadedFor === userId) this.set(list.map((b) => b.userId));
      },
      () => {
        if (this.loadedFor === userId) this.loadedFor = null;
      },
    );
    return this.loading;
  }

  /** Block a player: hidden at once, then told to the server (put back if the server refuses). */
  async block(ctx: BlocksContext, userId: string): Promise<void> {
    const before = this.ids;
    this.set([...before, userId]);
    try {
      await blocksApi.add(ctx, userId);
    } catch (e) {
      this.set([...before]);
      throw e;
    }
  }

  async unblock(ctx: BlocksContext, userId: string): Promise<void> {
    await blocksApi.remove(ctx, userId);
    this.set([...this.ids].filter((id) => id !== userId));
  }

  /** Signed out or another account: start again from nothing. */
  forget(): void {
    this.loadedFor = null;
    this.loading = null;
    this.set([]);
  }
}

export const blockedStore = new BlockedStore();

/** The blocked ids, loading them once the player has an account on the server (`ctx` null: not signed in). */
export function useBlockedIds(ctx: BlocksContext | null, userId: string | null): ReadonlySet<string> {
  const [ids, setIds] = useState(blockedStore.get());
  useEffect(() => blockedStore.subscribe(setIds), []);
  useEffect(() => {
    if (ctx && userId) void blockedStore.load(ctx, userId);
    // The context object is rebuilt each render; the account is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);
  return ids;
}

/** Chat lines or emotes, without the ones from a seat a blocked account holds. */
export function hideBlocked<T extends { seat: number }>(items: readonly T[], seats: ReadonlyArray<{ seat: number; userId?: string; isBot?: boolean }>, blocked: ReadonlySet<string>): T[] {
  if (blocked.size === 0) return items.slice();
  const hidden = new Set(seats.filter((s) => !s.isBot && s.userId && blocked.has(s.userId)).map((s) => s.seat));
  return hidden.size === 0 ? items.slice() : items.filter((i) => !hidden.has(i.seat));
}
