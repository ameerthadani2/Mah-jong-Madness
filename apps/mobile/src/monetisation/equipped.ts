/**
 * Which owned cosmetics the player has put on, besides the table look (which stays in
 * `settings.tableTheme`): a tile back, an avatar frame, an emote pack and a win celebration.
 * Kept on the device; only owned items can be equipped, and anything the wallet no longer shows
 * (another account signed in, a refund) falls back to the default.
 *
 * Pure TypeScript; ./useEquipped.ts keeps it in storage and shares it with the screens.
 */
import { CELEBRATIONS, EMOTE_PACKS, FRAMES, TILE_BACKS } from './cosmetics';
import { ownsCosmetic, type Wallet } from './wallet';

export interface Equipped {
  tileBack: string | null;
  frame: string | null;
  emotes: string | null;
  celebration: string | null;
}

export type EquipSlot = keyof Equipped;

export const NOTHING_EQUIPPED: Equipped = { tileBack: null, frame: null, emotes: null, celebration: null };

/** The items each slot accepts. */
export const SLOT_ITEMS: Record<EquipSlot, readonly string[]> = {
  tileBack: TILE_BACKS.map((b) => b.id),
  frame: FRAMES.map((f) => f.id),
  emotes: Object.keys(EMOTE_PACKS),
  celebration: [...CELEBRATIONS],
};

/** The slot a cosmetic goes in, or null for a table look or an unknown id. */
export function slotOf(id: string): EquipSlot | null {
  for (const slot of Object.keys(SLOT_ITEMS) as EquipSlot[]) if (SLOT_ITEMS[slot].includes(id)) return slot;
  return null;
}

/** A stored value read back: unknown slots and items are dropped. */
export function readEquipped(raw: unknown): Equipped {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pick = (slot: EquipSlot) => {
    const v = o[slot];
    return typeof v === 'string' && SLOT_ITEMS[slot].includes(v) ? v : null;
  };
  return { tileBack: pick('tileBack'), frame: pick('frame'), emotes: pick('emotes'), celebration: pick('celebration') };
}

/** What is actually in use: only items this wallet owns. */
export function equippedFor(equipped: Equipped, wallet: Wallet): Equipped {
  const keep = (id: string | null) => (id && ownsCosmetic(wallet, id) ? id : null);
  return { tileBack: keep(equipped.tileBack), frame: keep(equipped.frame), emotes: keep(equipped.emotes), celebration: keep(equipped.celebration) };
}

/** Put an item on (or with null, go back to the default). Refused (unchanged) for an item this wallet does not own. */
export function equip(equipped: Equipped, slot: EquipSlot, id: string | null, wallet: Wallet): Equipped {
  if (id !== null && (!SLOT_ITEMS[slot].includes(id) || !ownsCosmetic(wallet, id))) return equipped;
  return { ...equipped, [slot]: id };
}

/** The emotes the picker offers: the free ones, then the equipped pack's. */
export function emoteChoices(freeEmotes: readonly string[], equipped: Equipped): string[] {
  const pack = equipped.emotes ? (EMOTE_PACKS as Record<string, readonly string[]>)[equipped.emotes] : undefined;
  return [...freeEmotes, ...(pack ?? [])];
}
