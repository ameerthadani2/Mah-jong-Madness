/**
 * The server's product table against the app's (apps/mobile/src/monetisation/catalog.ts): every
 * product the server sells exists in the app with the same kind, price tier and diamonds, and
 * every launch product the app shows is one the server sells. The app's file is imported by path
 * at run time (it is pure TypeScript), so the server's typecheck does not pull in the app.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { productForStoreId, SERVER_PRODUCTS, serverProduct } from '../src/catalog';

interface AppProduct {
  id: string;
  kind: string;
  priceUsd: number;
  diamonds?: number;
  diamondPrice?: number;
  unlocks?: string;
  tier?: string;
  period?: string;
}

let app: AppProduct[] = [];
let sellable: AppProduct[] = [];

beforeAll(async () => {
  const path = fileURLToPath(new URL('../../mobile/src/monetisation/catalog.ts', import.meta.url));
  const mod = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
  app = mod.ALL_PRODUCTS as AppProduct[];
  // The app may name its launch list; otherwise the launch catalogue is diamond packs, table looks, Gold and Platinum.
  const named = (mod.SELLABLE_PRODUCTS ?? mod.LAUNCH_PRODUCTS) as AppProduct[] | undefined;
  sellable = named ?? app.filter((p) => p.kind === 'diamonds' || (p.kind === 'cosmetic' && p.id.startsWith('theme.')) || (p.kind === 'subscription' && (p.tier === 'gold' || p.tier === 'platinum')));
});

describe('server catalogue', () => {
  it('sells only products the app lists, with the same kind, price tier and diamonds', () => {
    expect(app.length).toBeGreaterThan(0);
    for (const p of SERVER_PRODUCTS) {
      const a = app.find((x) => x.id === p.id);
      expect(a, p.id).toBeDefined();
      expect({ id: p.id, kind: a!.kind, priceUsd: a!.priceUsd }).toEqual({ id: p.id, kind: p.kind, priceUsd: p.priceUsd });
      if (p.kind === 'diamonds') expect(a!.diamonds, p.id).toBe(p.diamonds + p.bonus);
      if (p.kind === 'cosmetic') expect({ id: p.id, diamondPrice: a!.diamondPrice, unlocks: a!.unlocks }).toEqual({ id: p.id, diamondPrice: p.diamondPrice, unlocks: p.unlocks });
      if (p.kind === 'subscription') expect({ id: p.id, tier: a!.tier, period: a!.period }).toEqual({ id: p.id, tier: p.tier, period: p.period });
    }
  });

  it('sells every launch product the app shows', () => {
    expect(sellable.length).toBeGreaterThan(0);
    for (const a of sellable) expect(serverProduct(a.id)?.priceUsd, a.id).toBe(a.priceUsd);
  });

  it('does not sell what is not built (avatar and emote packs, VIP, club tiers, Coach Diamond, Table Pass)', () => {
    for (const id of ['avatars.zodiac', 'emotes.taiwan', 'vip.bronze.30', 'club.100', 'coach.diamond.month', 'coach.tablepass.year']) expect(serverProduct(id), id).toBeUndefined();
  });

  it('labels honest bonuses: the bonus is the stated share of the base pack', () => {
    const bonus = (id: string) => {
      const p = serverProduct(id);
      return p?.kind === 'diamonds' ? Math.round((p.bonus / p.diamonds) * 100) : NaN;
    };
    expect(bonus('diamonds.3450')).toBe(15);
    expect(bonus('diamonds.7500')).toBe(25);
    expect(bonus('diamonds.60')).toBe(0);
  });

  it('maps store product ids, including Play subscription base plans', () => {
    expect(productForStoreId('coach.gold.month')?.id).toBe('coach.gold.month');
    expect(productForStoreId('coach.platinum:year')?.id).toBe('coach.platinum.year');
    expect(productForStoreId('diamonds.600')?.id).toBe('diamonds.600');
    expect(productForStoreId('coach.gold:weekly')).toBeUndefined();
    expect(productForStoreId('')).toBeUndefined();
    expect(productForStoreId(42)).toBeUndefined();
  });
});
