import { describe, expect, it } from 'vitest';
import { emoteChoices, equip, equippedFor, NOTHING_EQUIPPED, readEquipped, slotOf } from './equipped';
import { EMPTY_WALLET, mirrorMe } from './wallet';

const S = Date.parse('2026-11-09T12:00:00.000Z');
const owning = (...cosmetics: string[]) => mirrorMe(EMPTY_WALLET, { user: { id: 'u1' }, wallet: { diamonds: 0, bonusDiamonds: 0 }, entitlements: [], cosmetics, serverNow: '2026-11-09T12:00:00.000Z' }, S);

describe('equipping cosmetics', () => {
  it('puts on only items the wallet owns, each in its own slot', () => {
    const w = owning('back.lotus', 'frame.jade', 'emotes.zodiac', 'win.petals', 'theme.jade');
    let e = equip(NOTHING_EQUIPPED, 'tileBack', 'back.lotus', w);
    e = equip(e, 'frame', 'frame.jade', w);
    e = equip(e, 'emotes', 'emotes.zodiac', w);
    e = equip(e, 'celebration', 'win.petals', w);
    expect(e).toEqual({ tileBack: 'back.lotus', frame: 'frame.jade', emotes: 'emotes.zodiac', celebration: 'win.petals' });
    expect(equip(e, 'tileBack', 'back.dragon', w)).toBe(e);
    expect(equip(e, 'tileBack', 'frame.jade', w)).toBe(e);
    expect(equip(e, 'frame', null, w).frame).toBeNull();
  });

  it('falls back to the default for anything the current wallet does not own', () => {
    const e = { tileBack: 'back.lotus', frame: 'frame.jade', emotes: null, celebration: 'win.dragon' };
    expect(equippedFor(e, owning('back.lotus'))).toEqual({ tileBack: 'back.lotus', frame: null, emotes: null, celebration: null });
    expect(equippedFor(e, EMPTY_WALLET)).toEqual(NOTHING_EQUIPPED);
  });

  it('reads a stored value safely', () => {
    expect(readEquipped({ tileBack: 'back.wave', frame: 'nope', emotes: 42, extra: 'x' })).toEqual({ tileBack: 'back.wave', frame: null, emotes: null, celebration: null });
    expect(readEquipped(null)).toEqual(NOTHING_EQUIPPED);
  });

  it('knows each item slot, and the emote picker adds the equipped pack after the free emotes', () => {
    expect([slotOf('back.jade'), slotOf('frame.star'), slotOf('emotes.festival'), slotOf('win.lanterns'), slotOf('theme.jade')]).toEqual(['tileBack', 'frame', 'emotes', 'celebration', null]);
    expect(emoteChoices(['thumbs', 'lol'], { ...NOTHING_EQUIPPED, emotes: 'emotes.teahouse' })).toEqual(['thumbs', 'lol', 'th.tea', 'th.bun', 'th.dumpling', 'th.noodles', 'th.mooncake', 'th.tangerine']);
    expect(emoteChoices(['thumbs'], NOTHING_EQUIPPED)).toEqual(['thumbs']);
  });
});
