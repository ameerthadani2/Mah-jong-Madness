import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { translator } from '../logic/translator.fixture';
import { ALL_PRODUCTS, BUNDLES, bundlePrice, COSMETICS, DIAMOND_PACKS, DIAMONDS_PER_DOLLAR, productByStoreId, productText, SELLABLE_PRODUCTS, STORE_PRODUCTS, SUBSCRIPTIONS } from './catalog';
import { CELEBRATIONS, EMOTE_PACKS, FELT_PATTERNS, FRAMES, PACK_EMOTE_IDS, TILE_BACKS } from './cosmetics';
import { storeQueryIds } from './providers';

const en = translator('en');
const zh = translator('zh-TW');

describe('launch catalogue', () => {
  it('sells only what ships: diamond packs, cosmetics and sets, Coach Gold and The Four Winds Club', () => {
    expect(ALL_PRODUCTS.map((p) => p.kind).sort()).toEqual([...Array(6).fill('diamonds'), ...Array(COSMETICS.length + BUNDLES.length).fill('cosmetic'), ...Array(4).fill('subscription')].sort());
    const shelf = (c: string) => COSMETICS.filter((p) => p.category === c).length;
    expect([shelf('table'), shelf('tileback'), shelf('frame'), shelf('emotes'), shelf('celebration')]).toEqual([12, 10, 12, 4, 4]);
    expect(BUNDLES.length).toBeGreaterThanOrEqual(3);
    expect(SUBSCRIPTIONS.map((p) => `${p.tier}/${p.period}`)).toEqual(['gold/month', 'gold/year', 'fourwinds/month', 'fourwinds/year']);
    // Removed until built: Diamond tier, Table Pass, zodiac avatars, the Taiwan emote set, VIP cards, club tiers.
    for (const gone of [/coach\.diamond/, /tablepass/, /avatars\./, /^emotes\.taiwan$/, /^vip\./, /^club\./]) {
      expect(ALL_PRODUCTS.filter((p) => gone.test(p.id)), String(gone)).toEqual([]);
    }
  });

  it('every diamond pack can be spent in full: the cosmetics add up to at least 10,000 diamonds', () => {
    const total = COSMETICS.reduce((n, p) => n + (p.diamondPrice ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(10_000);
    for (const pack of DIAMOND_PACKS) expect(pack.diamonds!, pack.id).toBeLessThanOrEqual(total);
  });

  it('bundles hold cosmetics sold alone, cost less than their parts, and charge only for what is missing', () => {
    for (const b of BUNDLES) {
      const parts = b.contains!.map((id) => COSMETICS.find((c) => c.id === id));
      expect(parts.every(Boolean), b.id).toBe(true);
      const sum = parts.reduce((n, c) => n + (c?.diamondPrice ?? 0), 0);
      expect(b.diamondPrice!, b.id).toBeLessThan(sum);
      expect(bundlePrice(b, () => false), b.id).toBe(b.diamondPrice);
      expect(bundlePrice(b, () => true), b.id).toBe(0);
      expect(bundlePrice(b, (id) => id !== b.contains![0]), b.id).toBeLessThanOrEqual(parts[0]!.diamondPrice!);
    }
    expect(bundlePrice(BUNDLES.find((b) => b.id === 'bundle.nightmarket')!, (id) => id === 'theme.nightmarket')).toBe(610);
  });

  it('every cosmetic on sale has a code-drawn design, and every design is on sale', () => {
    const ids = (c: string) => COSMETICS.filter((p) => p.category === c).map((p) => p.id).sort();
    expect(ids('tileback')).toEqual(TILE_BACKS.map((b) => b.id).sort());
    expect(ids('frame')).toEqual(FRAMES.map((f) => f.id).sort());
    expect(ids('emotes')).toEqual(Object.keys(EMOTE_PACKS).sort());
    expect(ids('celebration')).toEqual([...CELEBRATIONS].sort());
    for (const pack of Object.values(EMOTE_PACKS)) {
      expect(pack.length).toBe(6);
      for (const id of pack) expect(id.length, id).toBeLessThanOrEqual(16);
    }
    expect(new Set(PACK_EMOTE_IDS).size).toBe(24);
    for (const p of COSMETICS.filter((c) => c.category !== 'table')) expect(p.unlocks, p.id).toBe(p.id);
  });

  it('no product shows or names coins, chips or money', () => {
    for (const p of ALL_PRODUCTS) {
      for (const text of [p.title, p.description, productText(p, en).title, productText(p, en).description]) expect(text, p.id).not.toMatch(/\bcoins?\b|\bchips?\b|\bcash\b|\bmoney\b|\bjackpot\b/i);
      for (const text of [productText(p, zh).title, productText(p, zh).description]) expect(text, p.id).not.toMatch(/金幣|籌碼|現金|錢/);
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
    for (const p of [...COSMETICS, ...BUNDLES]) {
      const row = section.split('\n').find((l) => l.startsWith(`| \`${p.id}\``));
      expect(row, p.id).toBeDefined();
      expect(row!.split('|').map((c) => c.trim()).slice(2, 4), p.id).toEqual([p.title, p.diamondPrice!.toLocaleString('en')]);
    }
    for (const p of SUBSCRIPTIONS) {
      expect(section, p.id).toContain(`\`${p.storeId}\``);
      expect(section, p.id).toContain(`$${p.priceUsd}`);
    }
  });

  it('every table look unlocks a premium table theme that exists, with a felt pattern for the new ones', () => {
    const themes = readFileSync(join(__dirname, '..', 'themes.ts'), 'utf8');
    for (const p of COSMETICS.filter((c) => c.category === 'table')) expect(themes, p.id).toMatch(new RegExp(`id: '${p.unlocks}'[\\s\\S]*?premium: true`));
    for (const pattern of FELT_PATTERNS) expect(themes, pattern).toContain(`pattern: '${pattern}'`);
  });
});
