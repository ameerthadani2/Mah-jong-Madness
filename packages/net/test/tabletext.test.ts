import { describe, expect, it } from 'vitest';
import { EMOTE_PACK_IDS, emotePackOf, FREE_EMOTE_IDS, isQuickChatId, isTableEmoteId, QUICK_CHAT_IDS } from '../src';

describe('table text ids', () => {
  it('accepts exactly the listed quick phrases', () => {
    for (const id of QUICK_CHAT_IDS) expect(isQuickChatId(id)).toBe(true);
    for (const v of ['Nice!', 'NICE', ' nice', 'nice ', '', 'toString', '__proto__', 'hasOwnProperty', 0, null, undefined, {}, ['nice']]) expect(isQuickChatId(v)).toBe(false);
  });

  it('accepts free emotes and pack emotes, and names the pack a paid emote belongs to', () => {
    for (const id of FREE_EMOTE_IDS) {
      expect(isTableEmoteId(id)).toBe(true);
      expect(emotePackOf(id)).toBeUndefined();
    }
    for (const [pack, ids] of Object.entries(EMOTE_PACK_IDS)) {
      expect(ids).toHaveLength(6);
      for (const id of ids) {
        expect(isTableEmoteId(id)).toBe(true);
        expect(emotePackOf(id)).toBe(pack);
      }
    }
    for (const v of ['zd.unicorn', 'emotes.zodiac', 'constructor', 'THUMBS', '', 3, null, undefined]) {
      expect(isTableEmoteId(v)).toBe(false);
      expect(emotePackOf(v)).toBeUndefined();
    }
  });

  it('keeps every id short, unique and plain', () => {
    const all = [...QUICK_CHAT_IDS, ...FREE_EMOTE_IDS, ...Object.values(EMOTE_PACK_IDS).flat()];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^[A-Za-z][A-Za-z.]{1,15}$/);
  });
});
