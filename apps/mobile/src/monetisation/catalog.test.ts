import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { translator } from '../logic/translator.fixture';
import { ALL_PRODUCTS, COSMETICS, DIAMOND_PACKS, DIAMONDS_PER_DOLLAR, productByStoreId, productText, SELLABLE_PRODUCTS, STORE_PRODUCTS, SUBSCRIPTIONS } from './catalog';
import { storeQueryIds } from './providers';

const en = translator('en');
const zh = translator('zh-TW');

describe('launch catalogue', () => {
  it('sells only what ships: diamond packs, the four table looks, Coach Gold and The Four Winds Club', () => {
    expect(ALL_PRODUCTS.map((p) => p.kind).sort()).toEqual([...Array(6).fill('diamonds'), ...Array(4).fill('cosmetic'), ...Array(4).fill('subscription')].sort());
    expect(COSMETICS.map((p) => p.unlocks).sort()).toEqual(['bamboo', 'imperial', 'jade', 'nightmarket']);
    expect(SUBSCRIPTIONS.map((p) => `${p.tier}/${p.period}`)).toEqual(['gold/month', 'gold/year', 'fourwinds/month', 'fourwinds/year']);
    // Removed until built: Diamond tier, Table Pass, zodiac avatars, Taiwan emotes, VIP cards, club tiers.
    for (const gone of [/coach\.diamond/, /tablepass/, /avatars\./, /emotes\./, /^vip\./, /^club\./]) {
      expect(ALL_PRODUCTS.filter((p) => gone.test(p.id)), String(gone)).toEqual([]);
    }
  });

  it('every product the Shop shows has copy in both locales', () => {
    for (const p of SELLABLE_PRODUCTS) {
      const e = productText(p, en);
      const z = productText(p, zh);
      expect(e.title, p.id).toBe(p.title);
      expect(e.description, p.id).toBe(p.description);
      expect(z.title, p.id).toBe(p.titleZh);
      expect(z.description, p.id).toMatch(/[一-鿿]/);
      expect(Boolean(z.badge), p.id).toBe(Boolean(p.badge));
    }
  });

  it('everything sold for money has a unique store id; table looks are diamonds-only', () => {
    expect(STORE_PRODUCTS.map((p) => p.kind).sort()).toEqual([...DIAMOND_PACKS, ...SUBSCRIPTIONS].map((p) => p.kind).sort());
    const ids = new Set<string>();
    for (const p of STORE_PRODUCTS) {
      // App Store and Google Play both accept lowercase letters, digits, dots and underscores.
      expect(p.storeId, p.id).toMatch(/^[a-z0-9][a-z0-9._]*$/);
      expect(ids.has(p.storeId!), p.storeId).toBe(false);
      ids.add(p.storeId!);
      expect(productByStoreId(p.storeId!)).toBe(p);
    }
    for (const p of COSMETICS) {
      expect(p.storeId, p.id).toBeUndefined();
      expect(p.diamondPrice, p.id).toBeGreaterThan(0);
    }
  });

  it('maps a Google Play `subscription:basePlan` identifier back to the product, and asks the store for both forms', () => {
    expect(productByStoreId('coach.gold:month')?.id).toBe('coach.gold.month');
    expect(productByStoreId('fourwinds:year')?.id).toBe('fourwinds.year');
    expect(productByStoreId('coach.gold:weekly')).toBeUndefined();
    expect(productByStoreId('theme.jade')).toBeUndefined();
    const q = storeQueryIds();
    expect(q.subscriptions).toEqual(expect.arrayContaining(['coach.gold.month', 'coach.gold', 'fourwinds']));
    expect(q.other).toEqual(DIAMOND_PACKS.map((p) => p.storeId));
  });

  it('diamond bonuses are exactly what the badge says, over the 60-per-dollar base', () => {
    let lastRate = 0;
    for (const p of DIAMOND_PACKS) {
      const base = Math.round((p.priceUsd + 0.01) * DIAMONDS_PER_DOLLAR);
      expect(p.baseDiamonds, p.id).toBe(base);
      expect(p.diamonds, p.id).toBe(base + (p.bonusDiamonds ?? 0));
      if (p.bonusDiamonds) {
        expect(p.badge, p.id).toBe(`+${Math.round((p.bonusDiamonds / base) * 100)}%`);
        expect(p.description, p.id).toContain(`plus ${p.bonusDiamonds.toLocaleString('en')} bonus`);
      } else expect(p.badge ?? '', p.id).not.toMatch(/%/);
      const rate = (p.diamonds ?? 0) / p.priceUsd;
      expect(rate, p.id).toBeGreaterThanOrEqual(lastRate - 0.5);
      lastRate = rate;
    }
  });

  it('pack copy only promises what diamonds buy', () => {
    const cheapest = Math.min(...COSMETICS.map((p) => p.diamondPrice!));
    expect(DIAMOND_PACKS.find((p) => p.id === 'diamonds.300')!.diamonds).toBeGreaterThanOrEqual(cheapest);
    expect(DIAMOND_PACKS.find((p) => p.id === 'diamonds.600')!.diamonds).toBeGreaterThanOrEqual(2 * cheapest);
    for (const p of DIAMOND_PACKS) expect(p.description, p.id).not.toMatch(/emote|VIP|club/i);
  });

  it('docs/MONETISATION.md lists the same catalogue', () => {
    const doc = readFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'MONETISATION.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## Catalogue'), doc.indexOf('## Compliance guardrails'));
    for (const p of DIAMOND_PACKS) {
      const row = section.split('\n').find((l) => l.startsWith(`| \`${p.storeId}\``));
      expect(row, p.id).toBeDefined();
      const cells = row!.split('|').map((c) => c.trim());
      expect(cells.slice(2, 5), p.id).toEqual([`$${p.priceUsd}`, p.diamonds!.toLocaleString('en'), p.bonusDiamonds!.toLocaleString('en')]);
      expect(cells[5], p.id).toBe(p.badge ?? '');
    }
    for (const p of COSMETICS) expect(section, p.id).toContain(`${p.title.replace(/ table$/, '')} ${p.diamondPrice}`);
    for (const p of SUBSCRIPTIONS) {
      expect(section, p.id).toContain(`\`${p.storeId}\``);
      expect(section, p.id).toContain(`$${p.priceUsd}`);
    }
  });

  it('every look unlocks a premium table theme that exists', () => {
    const themes = readFileSync(join(__dirname, '..', 'themes.ts'), 'utf8');
    for (const p of COSMETICS) expect(themes, p.id).toMatch(new RegExp(`id: '${p.unlocks}'[\\s\\S]*?premium: true`));
  });
});
