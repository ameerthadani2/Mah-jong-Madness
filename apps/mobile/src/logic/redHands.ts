/**
 * The hands this device found red at online tables, kept apart from the record of the table (src/app-state.tsx): a small
 * list, written the moment a hand turns red, so that a red verdict outlives a save of the record that was not written (a
 * full storage, a write that failed) and comes back after a cold start (`TableClient.keepRed`). Pure: src/storage.ts reads
 * and writes it.
 */
import type { RedHand } from '@mjm/net';

export interface KeptRed extends RedHand {
  signalUrl: string;
  roomCode: string;
}

/** How many red hands are kept (the newest). */
export const RED_MAX = 40;

const sameHand = (a: KeptRed, b: KeptRed) => a.signalUrl === b.signalUrl && a.roomCode === b.roomCode && a.matchId === b.matchId && a.hand === b.hand;

/** The list with the red hands of the table at `roomCode` added (those not on it yet); the same list when there are none. */
export function withRed(list: readonly KeptRed[], signalUrl: string, roomCode: string, red: readonly RedHand[]): readonly KeptRed[] {
  const fresh = red.map((r) => ({ signalUrl, roomCode, ...r })).filter((r) => !list.some((k) => sameHand(k, r)));
  return fresh.length === 0 ? list : [...list, ...fresh].slice(-RED_MAX);
}

/** The red hands kept for the table at this game server and room. */
export function redFor(list: readonly KeptRed[], signalUrl: string, roomCode: string): RedHand[] {
  return list.filter((k) => k.signalUrl === signalUrl && k.roomCode === roomCode).map(({ matchId, hand, failures }) => ({ matchId, hand, failures }));
}

/** The entries read back from storage: well-formed ones only, at most RED_MAX. */
export function validRed(raw: unknown): KeptRed[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is KeptRed => {
      if (!e || typeof e !== 'object') return false;
      const x = e as Record<string, unknown>;
      return typeof x.signalUrl === 'string' && typeof x.roomCode === 'string' && typeof x.matchId === 'string' && Number.isInteger(x.hand) && Array.isArray(x.failures) && x.failures.every((f) => typeof f === 'string');
    })
    .slice(-RED_MAX);
}
