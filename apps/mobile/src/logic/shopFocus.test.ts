import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en, zhTW } from '../i18n/locales';
import { SUBSCRIPTIONS, productText } from '../monetisation/catalog';
import { plansInOrder, shopTabFor } from './shopFocus';
import { translator } from './translator.fixture';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('arriving at the Shop for a plan', () => {
  it('opens on the Plans tab, and on Diamonds when nothing sent the player', () => {
    expect(shopTabFor('gold')).toBe('coach');
    expect(shopTabFor('fourwinds')).toBe('coach');
    expect(shopTabFor(undefined)).toBe('diamonds');
  });

  it('puts the plan the player was told about first', () => {
    expect(plansInOrder(SUBSCRIPTIONS, 'fourwinds').map((p) => p.id)).toEqual(['fourwinds.month', 'fourwinds.year', 'coach.gold.month', 'coach.gold.year']);
    expect(plansInOrder(SUBSCRIPTIONS, 'gold').map((p) => p.id)).toEqual(SUBSCRIPTIONS.map((p) => p.id));
    expect(plansInOrder(SUBSCRIPTIONS, undefined)).toEqual(SUBSCRIPTIONS);
  });

  it('"See plans" after a used Puzzle Rush or hand review names the plan that lifts the limit', () => {
    expect(read('screens/PuzzleScreens.tsx')).toMatch(/app\.go\(\{ name: 'shop', focus: 'gold' \}\)/);
    expect(read('screens/ReviewScreen.tsx')).toMatch(/app\.go\(\{ name: 'shop', focus: 'fourwinds' \}\)/);
    for (const f of ['screens/PuzzleScreens.tsx', 'screens/ReviewScreen.tsx']) expect(read(f), f).not.toMatch(/app\.go\(\{ name: 'shop' \}\)/);
  });

  it('shows the plan cards above their explanation and scrolls them into view', () => {
    const shop = read('screens/ShopScreen.tsx');
    const plans = shop.indexOf('testID="shop-plans"');
    expect(plans).toBeGreaterThan(0);
    expect(shop.indexOf("t('shop.coach.body')")).toBeGreaterThan(plans);
    expect(shop).toMatch(/onLayout=\{\(e\) => showPlans\(e\.nativeEvent\.layout\.y\)\}/);
    expect(shop).toMatch(/scroller\.current\?\.scrollTo\(/);
    expect(shop).toMatch(/plansInOrder\(SUBSCRIPTIONS, focus\)/);
  });

  it('the Rush limit names the plan as the Shop does, in both languages', () => {
    const t = translator('en');
    expect(t('shop.rushUsed', { plan: t('shop.tiers.gold') })).toBe('Free accounts get one Puzzle Rush a day. Coach Gold makes it unlimited.');
    const z = translator('zh-TW');
    expect(z('shop.rushUsed', { plan: z('shop.tiers.gold') })).toContain(zhTW.shop.tiers.gold);
    expect(zhTW.shop.products.coach_gold_month.title).toBe(zhTW.shop.tiers.gold);
    expect(read('screens/PuzzleScreens.tsx')).toMatch(/t\('shop\.rushUsed', \{ plan: t\('shop\.tiers\.gold'\) \}\)/);
  });
});

describe('a yearly plan', () => {
  it('is described as billed once a year and renewing until cancelled, never as a single payment', () => {
    for (const p of SUBSCRIPTIONS.filter((s) => s.period === 'year')) {
      expect(p.description, p.id).toMatch(/billed once a year\. Renews every year until cancelled\./);
      expect(productText(p, translator('en')).description, p.id).toBe(p.description);
      const zh = productText(p, translator('zh-TW')).description;
      expect(zh, p.id).toMatch(/每年扣款一次，取消前每年自動續訂/);
      expect(zh, p.id).not.toMatch(/一次付清/);
    }
    expect(JSON.stringify(en.shop)).not.toMatch(/billed once\./);
  });

  it('shows a plan card\'s terms whole', () => {
    expect(read('screens/ShopScreen.tsx')).toMatch(/numberOfLines=\{p\.kind === 'subscription' \? undefined : 2\}/);
  });
});
