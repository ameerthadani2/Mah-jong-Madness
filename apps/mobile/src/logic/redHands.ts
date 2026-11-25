/**
 * The hands this device found red at online tables, kept apart from the records of the tables (src/app-state.tsx): a
 * small list, written the moment a hand turns red, so that a red verdict outlives a save of the record that was not
 * written (a full storage, a write that failed), and the record itself: it comes back after a cold start, and to any
 * table client of that match, whether it takes a record up or holds none (`TableClient.keepRed`, and the welcome's
 * `keptRecord`). Kept by game server and match for a year. Pure: src/storage.ts reads and writes it.
 */
import type { RedHand } from '@mjm/net';

export interface KeptRed extends RedHand {
  signalUrl: string;
  /** The room the table was at when the hand turned red (for reading; the match is what it is kept by). */
  roomCode: string;
  /** When this device found it red (its clock); entries saved before it was kept read as found at load. */
  at?: number;
}

/** How many red hands are kept at most: room is made from the oldest hand of a match that keeps another, then the oldest. */
export const RED_MAX = 200;
/** How many hands of one match are kept (the first found): enough to show the match failed, and which hands. */
export const RED_PER_MATCH = 8;
/** How many failures of a hand are kept (its first). */
export const RED_FAILURES_KEPT = 3;
/** How long one is kept: a year. */
export const RED_TTL_MS = 365 * 24 * 60 * 60 * 1000;

const sameMatch = (a: Pick<KeptRed, 'signalUrl' | 'matchId'>, b: Pick<KeptRed, 'signalUrl' | 'matchId'>) => a.signalUrl === b.signalUrl && a.matchId === b.matchId;
const sameHand = (a: KeptRed, b: KeptRed) => sameMatch(a, b) && a.hand === b.hand;
const kept = (k: KeptRed, now: number) => k.at === undefined || (k.at > now - RED_TTL_MS && k.at < now + RED_TTL_MS);

/** `list` within RED_MAX: the oldest hand of a match that keeps another goes first, then the oldest. */
function within(list: readonly KeptRed[]): KeptRed[] {
  const out = list.slice();
  while (out.length > RED_MAX) {
    const i = out.findIndex((k, n) => out.some((o, m) => m !== n && sameMatch(o, k)));
    out.splice(i >= 0 ? i : 0, 1);
  }
  return out;
}

/**
 * The list with the red hands of a table of game server `signalUrl` at `roomCode` added (those not on it yet, up to
 * RED_PER_MATCH of a match), the expired ones gone; the same list when nothing changed.
 */
export function withRed(list: readonly KeptRed[], signalUrl: string, roomCode: string, red: readonly RedHand[], now: number = Date.now()): readonly KeptRed[] {
  const live = list.filter((k) => kept(k, now));
  const fresh: KeptRed[] = [];
  for (const r of red) {
    const k: KeptRed = { signalUrl, roomCode, matchId: r.matchId, hand: r.hand, failures: r.failures.slice(0, RED_FAILURES_KEPT), at: now };
    if ([...live, ...fresh].some((x) => sameHand(x, k))) continue;
    if ([...live, ...fresh].filter((x) => sameMatch(x, k)).length >= RED_PER_MATCH) continue;
    fresh.push(k);
  }
  if (fresh.length === 0 && live.length === list.length) return list;
  return within([...live, ...fresh]);
}

/** The red hands kept for game server `signalUrl`, every match (a table client keeps those of its own match). */
export function redFor(list: readonly KeptRed[], signalUrl: string, now: number = Date.now()): RedHand[] {
  return list.filter((k) => k.signalUrl === signalUrl && kept(k, now)).map(({ matchId, hand, failures }) => ({ matchId, hand, failures }));
}

/** The entries read back from storage: well-formed, unexpired ones only, within RED_MAX. */
export function validRed(raw: unknown, now: number = Date.now()): KeptRed[] {
  if (!Array.isArray(raw)) return [];
  return within(
    raw.filter((e): e is KeptRed => {
      if (!e || typeof e !== 'object') return false;
      const x = e as Record<string, unknown>;
      return typeof x.signalUrl === 'string' && typeof x.roomCode === 'string' && typeof x.matchId === 'string' && Number.isInteger(x.hand) && Array.isArray(x.failures) && x.failures.every((f) => typeof f === 'string') && (x.at === undefined || (typeof x.at === 'number' && Number.isFinite(x.at))) && kept(x as unknown as KeptRed, now);
    }),
  );
}
