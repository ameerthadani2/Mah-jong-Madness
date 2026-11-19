/**
 * The server's product table (apps/signal/src/catalog.ts) against the app's
 * (apps/mobile/src/monetisation/catalog.ts): every product the server sells exists in the app with the
 * same kind, price tier and diamonds, and every launch product the app shows is one the server sells.
 * The app's file is imported by path at run time (it is pure TypeScript), so the typecheck of this
 * folder does not pull in the app. The server's own rules for its table (enough to spend, honest
 * bundles and bonuses, store ids) are checked in apps/signal/test/catalog.test.ts.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SERVER_PRODUCTS, serverProduct } from '../apps/signal/src/catalog';

interface AppProduct {
  id: string;
  kind: string;
  priceUsd: number;
  diamonds?: number;
  diamondPrice?: number;
  unlocks?: string;
  category?: string;
  contains?: string[];
  tier?: string;
  period?: string;
}

let app: AppProduct[] = [];
let sellable: AppProduct[] = [];

beforeAll(async () => {
  const path = fileURLToPath(new URL('../apps/mobile/src/monetisation/catalog.ts', import.meta.url));
  const mod = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
  app = mod.ALL_PRODUCTS as AppProduct[];
  // The app may name its launch list; otherwise the launch catalogue is diamond packs, cosmetics, Coach Gold and The Four Winds Club.
  const named = (mod.SELLABLE_PRODUCTS ?? mod.LAUNCH_PRODUCTS) as AppProduct[] | undefined;
  sellable = named ?? app.filter((p) => p.kind === 'diamonds' || p.kind === 'cosmetic' || (p.kind === 'subscription' && (p.tier === 'gold' || p.tier === 'fourwinds')));
});

describe('the server catalogue against the app catalogue', () => {
  it('sells only products the app lists, with the same kind, price tier and diamonds', () => {
    expect(app.length).toBeGreaterThan(0);
    for (const p of SERVER_PRODUCTS) {
      const a = app.find((x) => x.id === p.id);
      expect(a, p.id).toBeDefined();
      expect({ id: p.id, kind: a!.kind, priceUsd: a!.priceUsd }).toEqual({ id: p.id, kind: p.kind, priceUsd: p.priceUsd });
      if (p.kind === 'diamonds') expect(a!.diamonds, p.id).toBe(p.diamonds + p.bonus);
      if (p.kind === 'cosmetic') {
        expect({ id: p.id, diamondPrice: a!.diamondPrice, unlocks: a!.unlocks, category: a!.category, contains: a!.contains }).toEqual({ id: p.id, diamondPrice: p.diamondPrice, unlocks: p.unlocks, category: p.category, contains: p.contains });
      }
      if (p.kind === 'subscription') expect({ id: p.id, tier: a!.tier, period: a!.period }).toEqual({ id: p.id, tier: p.tier, period: p.period });
    }
  });

  it('sells every launch product the app shows', () => {
    expect(sellable.length).toBeGreaterThan(0);
    for (const a of sellable) expect(serverProduct(a.id)?.priceUsd, a.id).toBe(a.priceUsd);
  });

  it('the app and the server list exactly the same products', () => {
    expect(app.map((p) => p.id).sort()).toEqual(SERVER_PRODUCTS.map((p) => p.id).sort());
  });
});
