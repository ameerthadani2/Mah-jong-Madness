/**
 * The server's product table (src/catalog.ts) on its own terms: enough cosmetics to spend the largest
 * pack, bundles that are honest, bonuses as stated, nothing sold that is not built, and the store ids
 * it maps. That the app's catalogue lists the same products is checked at the repository root
 * (tests/catalog.test.ts), since it reads the app's file.
 */
import { describe, expect, it } from 'vitest';
import { bundlePrice, productForStoreId, SERVER_PRODUCTS, serverProduct, type Cosmetic } from '../src/catalog';

describe('server catalogue', () => {
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
