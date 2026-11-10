/**
 * Everything a player can say at a table: a fixed set of quick phrases and emotes, each sent as
 * its id. There is no free text. The host relays a `chat` or `emote` frame only when it carries
 * one of these ids, and every app draws the phrase in the reader's own language
 * (`table.quickChat.<id>`) and the emote from its own art, so nothing a modified client types
 * can reach another player.
 *
 * The paid emote packs are listed here with their product ids so the server can check that the
 * sender owns the pack (apps/signal rooms.ts). The app's shop keeps the same lists
 * (apps/mobile/src/monetisation/cosmetics.ts); a test there fails when the two drift apart.
 */

/** Quick-phrase ids, in the order the app offers them. */
export const QUICK_CHAT_IDS = ['nice', 'sorry', 'gg', 'hurry', 'goodHand', 'dealtIn', 'oneMore', 'faster'] as const;
export type QuickChatId = (typeof QUICK_CHAT_IDS)[number];

/** The emotes every player has. */
export const FREE_EMOTE_IDS = ['thumbs', 'lol', 'wow', 'cry', 'fire', 'love', 'zzz', 'hu'] as const;
export type FreeEmoteId = (typeof FREE_EMOTE_IDS)[number];

/** The paid emote packs: product id (the entitlement a buyer holds) to its six emote ids. */
export const EMOTE_PACK_IDS = {
  'emotes.teahouse': ['th.tea', 'th.bun', 'th.dumpling', 'th.noodles', 'th.mooncake', 'th.tangerine'],
  'emotes.nightmarket': ['nm.boba', 'nm.skewer', 'nm.shavedice', 'nm.corn', 'nm.lantern', 'nm.firecracker'],
  'emotes.festival': ['fs.firework', 'fs.knot', 'fs.drum', 'fs.kite', 'fs.moon', 'fs.dragonboat'],
  'emotes.zodiac': ['zd.rat', 'zd.ox', 'zd.tiger', 'zd.rabbit', 'zd.dragon', 'zd.rooster'],
} as const satisfies Record<string, readonly string[]>;
export type EmotePackProductId = keyof typeof EMOTE_PACK_IDS;

const QUICK_CHATS: ReadonlySet<string> = new Set(QUICK_CHAT_IDS);
const FREE_EMOTES: ReadonlySet<string> = new Set(FREE_EMOTE_IDS);
const PACK_OF_EMOTE: ReadonlyMap<string, EmotePackProductId> = new Map(
  (Object.keys(EMOTE_PACK_IDS) as EmotePackProductId[]).flatMap((pack) => EMOTE_PACK_IDS[pack].map((id) => [id, pack] as const)),
);

/** Whether `v` is a quick-phrase id (the only thing a `chat` frame may carry). */
export function isQuickChatId(v: unknown): v is QuickChatId {
  return typeof v === 'string' && QUICK_CHATS.has(v);
}

/** The product id of the paid pack an emote belongs to; undefined for a free emote or an unknown id. */
export function emotePackOf(id: unknown): EmotePackProductId | undefined {
  return typeof id === 'string' ? PACK_OF_EMOTE.get(id) : undefined;
}

/** Whether `v` is an emote id, free or from a paid pack (the only thing an `emote` frame may carry). */
export function isTableEmoteId(v: unknown): v is string {
  return typeof v === 'string' && (FREE_EMOTES.has(v) || PACK_OF_EMOTE.has(v));
}
