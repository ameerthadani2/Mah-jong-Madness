import { describe, expect, it } from 'vitest';
import { ALL_PRODUCTS, productText } from '../monetisation/catalog';
import { translator } from './translator.fixture';

const en = translator('en');
const zh = translator('zh-TW');

describe('catalog copy', () => {
  it('English locale copy matches the catalog source copy', () => {
    for (const p of ALL_PRODUCTS) {
      expect(productText(p, en), p.id).toEqual({ title: p.title, description: p.description, badge: p.badge });
    }
  });

  it('every product has Traditional Chinese copy, titled as the catalog’s titleZh', () => {
    for (const p of ALL_PRODUCTS) {
      const text = productText(p, zh);
      expect(text.title, p.id).toBe(p.titleZh);
      expect(text.description, p.id).toMatch(/[一-鿿]/);
      expect(Boolean(text.badge), p.id).toBe(Boolean(p.badge));
    }
  });
});
