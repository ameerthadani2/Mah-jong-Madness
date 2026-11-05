import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { translator } from '../logic/translator.fixture';
import { ALL_PRODUCTS, COSMETICS, DIAMOND_PACKS, DIAMONDS_PER_DOLLAR, productByStoreId, productText, SELLABLE_PRODUCTS, SUBSCRIPTIONS } from './catalog';

const en = translator('en');
const zh = translator('zh-TW');

describe('launch catalogue', () => {
  it('sells only what ships: diamond packs, the four table looks, Coach Gold monthly and yearly, Coach Platinum', () => {
    expect(ALL_PRODUCTS.map((p) => p.kind).sort()).toEqual([...Array(6).fill('diamonds'), ...Array(4).fill('cosmetic'), ...Array(3).fill('subscription')].sort());
    expect(COSMETICS.map((p) => p.unlocks).sort()).toEqual(['bamboo', 'imperial', 'jade', 'nightmarket']);
    expect(SUBSCRIPTIONS.map((p) => `${p.tier}/${p.period}`)).toEqual(['gold/month', 'gold/year', 'platinum/month']);
    // Removed until built: Diamond tier, Table Pass, zodiac avatars, Taiwan emotes, VIP cards, club tiers.
    for (const gone of [/coach\.diamond/, /tablepass/, /avatars\./, /emotes\./, /^vip\./, /^club\./]) {
      expect(ALL_PRODUCTS.filter((p) => gone.test(p.id)), String(gone)).toEqual([]);
    }
  });

  it('every sellable product has copy in both locales and a unique store id', () => {
    const ids = new Set<string>();
    for (const p of SELLABLE_PRODUCTS) {
      const e = productText(p, en);
      const z = productText(p, zh);
      expect(e.title, p.id).toBe(p.title);
      expect(e.description, p.id).toBe(p.description);
      expect(z.title, p.id).toBe(p.titleZh);
      expect(z.description, p.id).toMatch(/[一-鿿]/);
      expect(Boolean(z.badge), p.id).toBe(Boolean(p.badge));
      // App Store and Google Play both accept lowercase letters, digits, dots and underscores.
      expect(p.storeId, p.id).toMatch(/^[a-z0-9][a-z0-9._]*$/);
      expect(ids.has(p.storeId), p.storeId).toBe(false);
      ids.add(p.storeId);
      expect(productByStoreId(p.storeId)).toBe(p);
    }
  });

  it('maps a Google Play `product:basePlan` identifier back to the product', () => {
    expect(productByStoreId('coach.gold.month:monthly')?.id).toBe('coach.gold.month');
    expect(productByStoreId('nope')).toBeUndefined();
  });

  it('diamond bonuses are exactly what the badge says, over the 60-per-dollar base', () => {
    let lastRate = 0;
    for (const p of DIAMOND_PACKS) {
      const base = Math.round((p.priceUsd + 0.01) * DIAMONDS_PER_DOLLAR);
      expect(p.baseDiamonds, p.id).toBe(base);
      expect(p.diamonds, p.id).toBe(Math.round(base * (1 + (p.bonusPercent ?? 0) / 100)));
      if (p.bonusPercent) {
        expect(p.badge, p.id).toBe(`+${p.bonusPercent}%`);
        expect(p.description, p.id).toContain(`${p.bonusPercent}% bonus`);
      } else expect(p.badge ?? '', p.id).not.toMatch(/%/);
      const rate = (p.diamonds ?? 0) / p.priceUsd;
      expect(rate, p.id).toBeGreaterThanOrEqual(lastRate - 0.5);
      lastRate = rate;
    }
  });

  it('a diamond price never costs more than paying cash for the same look', () => {
    for (const p of COSMETICS) {
      expect(p.diamondPrice, p.id).toBeDefined();
      expect(p.diamondPrice! / DIAMONDS_PER_DOLLAR, p.id).toBeLessThanOrEqual(p.priceUsd + 0.01);
    }
  });

  it('pack copy only promises what diamonds buy (the cheapest look is affordable from the 300 pack)', () => {
    const cheapest = Math.min(...COSMETICS.map((p) => p.diamondPrice!));
    expect(DIAMOND_PACKS.find((p) => p.id === 'diamonds.300')!.diamonds).toBeGreaterThanOrEqual(cheapest);
    for (const p of DIAMOND_PACKS) expect(p.description, p.id).not.toMatch(/emote|VIP|club/i);
  });

  it('every look unlocks a premium table theme that exists', () => {
    const themes = readFileSync(join(__dirname, '..', 'themes.ts'), 'utf8');
    for (const p of COSMETICS) expect(themes, p.id).toMatch(new RegExp(`id: '${p.unlocks}'[\\s\\S]*?premium: true`));
  });
});
