/**
 * The store listings (docs/store/listing/*.md) against the stores' limits and our own rules:
 * the title and subtitle fit, keywords fit, no third-party trademarks, the fairness line says
 * only what the app does, and every subscription and what it unlocks is disclosed (2.3.2).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { SUBSCRIPTIONS } from './catalog';

const dir = join(__dirname, '..', '..', '..', '..', 'docs', 'store', 'listing');
const read = (lang: string) => readFileSync(join(dir, `${lang}.md`), 'utf8');

/** The text under a `## <heading>` (up to the next heading). */
function section(doc: string, heading: string): string {
  const start = doc.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const body = doc.slice(doc.indexOf('\n', start) + 1);
  const end = body.indexOf('\n## ');
  return (end < 0 ? body : body.slice(0, end)).trim();
}

describe('store listings', () => {
  for (const [lang, h] of [
    ['en', { name: 'Name', subtitle: 'Subtitle (App Store)', short: 'Short description (Play)', promo: 'Promotional text', keywords: 'Keywords (App Store)', description: 'Description' }],
    ['zh-TW', { name: '名稱', subtitle: '副標題（App Store）', short: '簡短說明（Play）', promo: '宣傳文字', keywords: '關鍵字', description: '說明' }],
  ] as const) {
    it(`${lang}: fits the store limits`, () => {
      const doc = read(lang);
      const len = (s: string) => [...s].length;
      expect(len(section(doc, h.name))).toBeGreaterThan(0);
      expect(len(section(doc, h.name))).toBeLessThanOrEqual(30);
      expect(len(section(doc, h.subtitle))).toBeLessThanOrEqual(30);
      expect(len(section(doc, h.short))).toBeLessThanOrEqual(80);
      expect(len(section(doc, h.promo))).toBeLessThanOrEqual(170);
      const keywords = section(doc, h.keywords);
      expect(len(keywords)).toBeLessThanOrEqual(100);
      expect(keywords).not.toMatch(/, /);
      expect(len(section(doc, h.description))).toBeLessThanOrEqual(4000);
    });

    it(`${lang}: no third-party trademarks, and a fairness line that claims only what the app does`, () => {
      // The copy itself, from the first heading on (the preamble above it states the rules).
      const raw = read(lang);
      const doc = raw.slice(raw.indexOf('\n## ')).toLowerCase();
      expect(doc).not.toMatch(/chess\.com|pokerbros|明星三缺一|神來也/);
      expect(doc).not.toMatch(/cannot be rigged|can't be rigged|not even the server|nobody.*can fix|無法作弊|包括伺服器|沒有人.*動手腳/);
    });
  }

  it('discloses each subscription and what it unlocks, and the auto-renewal terms', () => {
    const en = section(read('en'), 'Description');
    expect(en).toContain('Coach Gold');
    expect(en).toContain('The Four Winds Club');
    expect(en).toMatch(/Pro bots and unlimited Puzzle Rush/);
    expect(en).toMatch(/unlimited hand reviews, and creating and running your own clubs/);
    expect(en).toMatch(/renew automatically/);
    const zh = section(read('zh-TW'), '說明');
    expect(zh).toContain('教練 金');
    expect(zh).toContain('四風俱樂部');
    expect(zh).toMatch(/自動續訂/);
    for (const p of SUBSCRIPTIONS) expect(read('en'), p.id).toContain(`\`${p.storeId}\``);
  });

  it('the title is Mahjong Mania: Taiwan 16 and the Chinese name is 麻將狂熱', () => {
    expect(section(read('en'), 'Name')).toBe('Mahjong Mania: Taiwan 16');
    expect(section(read('zh-TW'), '名稱')).toContain('麻將狂熱');
  });
});
