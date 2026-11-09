/**
 * The server's product table against the app's (apps/mobile/src/monetisation/catalog.ts): every
 * product the server sells exists in the app with the same kind, price tier and diamonds, and
 * every launch product the app shows is one the server sells. The app's file is imported by path
 * at run time (it is pure TypeScript), so the server's typecheck does not pull in the app.
 */
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { bundlePrice, productForStoreId, SERVER_PRODUCTS, serverProduct, type Cosmetic } from '../src/catalog';

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
  const path = fileURLToPath(new URL('../../mobile/src/monetisation/catalog.ts', import.meta.url));
  const mod = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
  app = mod.ALL_PRODUCTS as AppProduct[];
  // The app may name its launch list; otherwise the launch catalogue is diamond packs, cosmetics, Coach Gold and The Four Winds Club.
  const named = (mod.SELLABLE_PRODUCTS ?? mod.LAUNCH_PRODUCTS) as AppProduct[] | undefined;
  sellable = named ?? app.filter((p) => p.kind === 'diamonds' || p.kind === 'cosmetic' || (p.kind === 'subscription' && (p.tier === 'gold' || p.tier === 'fourwinds')));
});

describe('server catalogue', () => {
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

  it('sells at least 10,000 diamonds of cosmetics, so even the largest pack can be spent in full', () => {
    const items = SERVER_PRODUCTS.filter((p): p is Cosmetic => p.kind === 'cosmetic' && !p.contains);
    const total = items.reduce((n, p) => n + p.diamondPrice, 0);
    expect(total).toBeGreaterThanOrEqual(10_000);
    for (const pack of SERVER_PRODUCTS.filter((p) => p.kind === 'diamonds')) expect(pack.kind === 'diamonds' && pack.diamonds + pack.bonus, pack.id).toBeLessThanOrEqual(total);
    const by = (c: string) => items.filter((p) => p.category === c).length;
    expect([by('table'), by('tileback'), by('frame'), by('emotes'), by('celebration')]).toEqual([12, 10, 12, 4, 4]);
  });

  it('bundles grant only cosmetics that are sold alone, cost less than their parts, and charge only for what is missing', () => {
    const bundles = SERVER_PRODUCTS.filter((p): p is Cosmetic => p.kind === 'cosmetic' && !!p.contains);
    expect(bundles.length).toBeGreaterThanOrEqual(3);
    for (const b of bundles) {
      const parts = b.contains!.map((id) => serverProduct(id));
      for (const part of parts) expect(part?.kind === 'cosmetic' && !part.contains, b.id).toBe(true);
      const sum = parts.reduce((n, p) => n + (p?.kind === 'cosmetic' ? p.diamondPrice : 0), 0);
      expect(b.diamondPrice, b.id).toBeLessThan(sum);
      expect(bundlePrice(b, () => false), b.id).toBe(b.diamondPrice);
      expect(bundlePrice(b, () => true), b.id).toBe(0);
      const first = b.contains![0];
      const firstPrice = (serverProduct(first) as Cosmetic).diamondPrice;
      expect(bundlePrice(b, (e) => e !== first), b.id).toBeLessThanOrEqual(firstPrice);
    }
  });

  it('does not sell what is not built (zodiac avatars, the Taiwan emotes, VIP, club tiers, Coach Diamond, Table Pass)', () => {
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
    expect(productForStoreId('fourwinds:year')?.id).toBe('fourwinds.year');
    expect(productForStoreId('diamonds.600')?.id).toBe('diamonds.600');
    expect(productForStoreId('coach.gold:weekly')).toBeUndefined();
    expect(productForStoreId('')).toBeUndefined();
    expect(productForStoreId(42)).toBeUndefined();
  });
});
