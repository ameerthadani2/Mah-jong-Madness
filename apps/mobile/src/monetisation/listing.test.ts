/**
 * The store listings (docs/store/listing/*.md) against the stores' limits and our own rules:
 * the title and subtitle fit, keywords fit, no third-party trademarks, the fairness line says
 * only what the app does, and every subscription and what it unlocks is disclosed (2.3.2).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { BOT_SKILLS } from '@mjm/engine';
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
    expect(zh).toContain('黃金教練');
    expect(zh).toContain('四風俱樂部');
    expect(zh).toMatch(/自動續訂/);
    for (const p of SUBSCRIPTIONS) expect(read('en'), p.id).toContain(`\`${p.storeId}\``);
  });

  it('names the puzzle leaderboards in the description and in What’s new, within the release-notes limit', () => {
    expect(section(read('en'), 'Description')).toMatch(/leaderboards/);
    expect(section(read('zh-TW'), '說明')).toContain('排行榜');
    const notes = { en: section(read('en'), 'What\'s new (first release)'), zh: section(read('zh-TW'), '新功能（首次發布）') };
    expect(notes.en).toMatch(/leaderboards/);
    expect(notes.zh).toContain('排行榜');
    // Google Play's release notes are the shorter field (500 characters).
    for (const n of Object.values(notes)) expect([...n].length).toBeLessThanOrEqual(500);
  });

  it('says of the Pro bots only what was measured: it folds far more when far from ready, and its edge over Club is small', () => {
    const en = section(read('en'), 'Description');
    expect(en).toMatch(/a pro that folds far more often when its hand is far from ready/);
    expect(en).not.toMatch(/weighs the value|danger of each discard|strongest|expert/i);
    expect(section(read('zh-TW'), '說明')).toMatch(/手牌離聽牌還遠時更常棄胡防守的高手/);
    expect(section(read('zh-TW'), '說明')).not.toMatch(/危險程度/);
    // The bot descriptions in Settings and the lobby, in both languages, give what held across four measurements
    // (two or more tiles from ready: roughly 2 to 2.5% deal-in against Club's 3.5 to 4.5%), never one sample's figure.
    const locales = join(__dirname, '..', 'i18n', 'locales');
    const ranges = { en: ['2 to 2.5%', '3.5 to 4.5%', 'four measurements'], 'zh-TW': ['2% 到 2.5%', '3.5% 到 4.5%', '四次測量'] };
    for (const lang of ['en', 'zh-TW'] as const) {
      const common = JSON.parse(readFileSync(join(locales, lang, 'common.json'), 'utf8')) as { bots: { pro: string } };
      const settings = JSON.parse(readFileSync(join(locales, lang, 'settings.json'), 'utf8')) as { botAbout: { pro: string } };
      for (const text of [common.bots.pro, settings.botAbout.pro]) {
        for (const r of ranges[lang]) expect(text, lang).toContain(r);
        expect(text, lang).not.toMatch(/2\.4%|放槍率 2\.4/);
      }
    }
    expect(BOT_SKILLS.pro.description).toContain("roughly 2 to 2.5% of the time against Club's 3.5 to 4.5%");
  });

  it('the title is Mahjong Mania: Taiwan 16 and the Chinese name is 麻將狂熱', () => {
    expect(section(read('en'), 'Name')).toBe('Mahjong Mania: Taiwan 16');
    expect(section(read('zh-TW'), '名稱')).toContain('麻將狂熱');
  });
});
