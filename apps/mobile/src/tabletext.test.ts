/**
 * The table's quick phrases and emotes are ids shared with the server (@mjm/net tabletext.ts).
 * The shop's emote packs, the emote art, the picker's lists and both locales must agree with
 * that list, or a player would be offered something the table drops, or sent something this app
 * cannot show.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMOTE_PACK_IDS, emotePackOf, FREE_EMOTE_IDS, isTableEmoteId, QUICK_CHAT_IDS } from '@mjm/net';
import en from './i18n/locales/en/table.json';
import zhTW from './i18n/locales/zh-TW/table.json';
import { EMOTE_PACKS, PACK_EMOTE_IDS, packOfEmote } from './monetisation/cosmetics';

const SRC = dirname(fileURLToPath(import.meta.url));
const source = (...path: string[]) => readFileSync(join(SRC, ...path), 'utf8');

describe('table text ids', () => {
  it("the shop's emote packs are the packs the table knows, emote for emote", () => {
    expect(EMOTE_PACKS).toEqual(EMOTE_PACK_IDS);
    expect(Object.keys(EMOTE_PACKS)).toEqual(Object.keys(EMOTE_PACK_IDS));
    expect(PACK_EMOTE_IDS).toHaveLength(Object.values(EMOTE_PACK_IDS).flat().length);
    for (const id of PACK_EMOTE_IDS) {
      expect(isTableEmoteId(id)).toBe(true);
      // The pack the shop sells an emote in is the pack the server checks the sender owns.
      expect(packOfEmote(id)).toBe(emotePackOf(id));
    }
  });

  it('the free emotes the app draws are the ones the table relays', () => {
    const drawn = /EMOTE_IDS = \[([^\]]*)\]/.exec(source('components', 'Emotes.tsx'));
    expect(drawn).not.toBeNull();
    expect([...drawn![1].matchAll(/'([\w.]+)'/g)].map((m) => m[1])).toEqual([...FREE_EMOTE_IDS]);
  });

  it("the picker's lists are the shared ids, not a copy", () => {
    // themes.ts reaches the app's translations, so it cannot be loaded here: read how it defines the lists.
    const themes = source('themes.ts');
    expect(themes).toMatch(/export const EMOTES: readonly string\[\] = FREE_EMOTE_IDS;/);
    expect(themes).toMatch(/export const QUICK_CHATS = QUICK_CHAT_IDS;/);
    expect(themes).toMatch(/import \{[^}]*\bFREE_EMOTE_IDS\b[^}]*\bQUICK_CHAT_IDS\b[^}]*\} from '@mjm\/net';/);
  });

  it('the table screen sends the phrase id and shows a line or an emote only for an id it knows', () => {
    // The screen cannot be mounted here, so this reads its chat lines: the id goes out, never the
    // translated phrase, and what comes in is drawn from the id in this reader's language.
    const screen = source('screens', 'TableScreen.tsx');
    expect(screen).toMatch(/session\.client\.chat\(id\)/);
    expect(screen).not.toMatch(/session\.client\.chat\((?!id\))/);
    expect(screen).toMatch(/isQuickChatId\(c\.text\) \? \[\{ name: c\.name, line: quickChatText\(c\.text\) \}\] : \[\]/);
    expect(screen).toMatch(/isTableEmoteId\(x\.emote\)/);
    expect(screen).not.toMatch(/\{c\.text\}/);
  });

  it('every quick phrase has its text in both languages, and the locales list no other phrase', () => {
    for (const [name, tree] of [
      ['en', en],
      ['zh-TW', zhTW],
    ] as const) {
      const phrases = (tree as { quickChat: Record<string, string> }).quickChat;
      expect(Object.keys(phrases).sort(), name).toEqual([...QUICK_CHAT_IDS].sort());
      for (const id of QUICK_CHAT_IDS) expect(phrases[id].trim().length, `${name} ${id}`).toBeGreaterThan(0);
    }
  });

  it('an English reader can read every quick phrase: none is left in Chinese', () => {
    const phrases = (en as { quickChat: Record<string, string> }).quickChat;
    for (const id of QUICK_CHAT_IDS) expect(phrases[id], id).not.toMatch(/[\u3400-\u9fff]/);
    // No two phrases say the same thing in either language.
    for (const tree of [en, zhTW]) {
      const texts = Object.values((tree as { quickChat: Record<string, string> }).quickChat);
      expect(new Set(texts).size).toBe(texts.length);
    }
    expect((zhTW as { quickChat: Record<string, string> }).quickChat.faster).not.toBe('快點啦');
  });

  it('every emote the picker can show has a spoken name in both languages, and the button is named by it, not by its id', () => {
    const ids = [...FREE_EMOTE_IDS, ...Object.values(EMOTE_PACK_IDS).flat()];
    for (const [name, tree] of [
      ['en', en],
      ['zh-TW', zhTW],
    ] as const) {
      const names = (tree as unknown as { emoteName: Record<string, unknown> }).emoteName;
      const at = (id: string) => id.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), names);
      for (const id of ids) {
        expect(typeof at(id), `${name} ${id}`).toBe('string');
        expect(String(at(id)).trim().length, `${name} ${id}`).toBeGreaterThan(0);
        expect(String(at(id)), `${name} ${id}`).not.toBe(id);
      }
    }
    const screen = source('screens', 'TableScreen.tsx');
    expect(screen).toContain("accessibilityLabel={t('table.a11y.emote', { name: emoteName(e, t) })}");
    expect(screen).not.toContain("t('table.a11y.emote', { name: e })");
  });
});
