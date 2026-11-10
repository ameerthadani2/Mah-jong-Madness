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
});
