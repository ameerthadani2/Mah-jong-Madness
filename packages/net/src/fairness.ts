/**
 * Commit–reveal shuffle seed.
 *
 * Five shares go into every deal: one per seat 0–3 and the host's own (seat 4).
 * Each human player's client picks its secret; the host picks the bots' secrets,
 * any stand-in shares and its own. Every commitment commitFor(secret) is
 * published to the table, and a client reveals its secret only once it holds
 * all five. The host then derives
 *   seed = sha256('mjm-seed-v2:' + matchId + ':' + hand + ':0=' + s0 + '|1=' + s1 + '|2=' + s2 + '|3=' + s3 + '|4=' + s4)
 * and deals. Exactly one share per seat 0–4 goes in, each bound to its seat: an
 * extra, missing or repeated share is an error, never a different seed. After
 * the hand the host publishes every secret, the restarts and the action log;
 * each client checks the commitments, re-derives the seed, replays the log and
 * compares hashes (see TableClient.verifyAudit).
 *
 * What this gives a player whose own share was used in a deal its client
 * watched whole, in one attempt: nobody, the host included, could choose the
 * seed after seeing that share. What it does not give: the host may restart a
 * ceremony (every restart is published, bounded by the number of human seats,
 * and keeps the hand 'partial'), may stand in for a seat (that seat's audit is
 * then only 'partial'), and learns the seed at deal time, so it is trusted not
 * to look at the wall during the hand or leak it. Online tables run on the
 * game server.
 */
import { sha256Hex, randomHex } from './sha256';

export interface Commitment {
  seat: number;
  hash: string;
}

export interface Reveal {
  seat: number;
  secret: string;
}

/** Version tag hashed into every seed; bump it whenever the derivation changes. */
export const SEED_DERIVATION = 'mjm-seed-v2';

/** Seats that contribute a share: the players 0–3 and the host (4). */
export const SHARE_SEATS = 5;

/** Secrets are lowercase hex (makeSecret gives 64 characters), so they never contain the separators. */
const SECRET = /^[0-9a-f]{1,128}$/;

export function isSecret(x: unknown): x is string {
  return typeof x === 'string' && SECRET.test(x);
}

export function makeSecret(): string {
  return randomHex(32);
}

export function commitFor(secret: string): string {
  return sha256Hex(`mjm-commit:${secret}`);
}

/**
 * The deal's seed from exactly one share per seat 0–4. Throws on a missing, repeated, extra or
 * out-of-range seat, or on a secret that is not hex, so nobody can hash in a share picked later.
 */
export function deriveSeed(matchId: string, reveals: Reveal[]): string {
  if (!Array.isArray(reveals) || reveals.length !== SHARE_SEATS) throw new Error(`A seed takes exactly ${SHARE_SEATS} shares, one per seat 0–4`);
  const bySeat = new Array<string | undefined>(SHARE_SEATS).fill(undefined);
  for (const r of reveals) {
    const seat = (r as Partial<Reveal> | null)?.seat;
    if (typeof seat !== 'number' || !Number.isInteger(seat) || seat < 0 || seat >= SHARE_SEATS) throw new Error(`Share for seat ${String(seat)} is out of range`);
    if (bySeat[seat] !== undefined) throw new Error(`Two shares for seat ${seat}`);
    if (!isSecret(r.secret)) throw new Error(`Share for seat ${seat} is not a hex secret`);
    bySeat[seat] = r.secret;
  }
  return sha256Hex(`${SEED_DERIVATION}:${matchId}:${bySeat.map((secret, seat) => `${seat}=${secret}`).join('|')}`);
}

/**
 * Every commitment has exactly one reveal, which matches it, and no reveal lacks a commitment.
 * `badSeats` lists the commitments without exactly one matching reveal, then any seat revealed
 * without a commitment.
 */
export function verifyReveals(commits: Commitment[], reveals: Reveal[]): { ok: boolean; badSeats: number[] } {
  const badSeats: number[] = [];
  for (const c of commits) {
    const mine = reveals.filter((x) => x.seat === c.seat);
    if (mine.length !== 1 || commitFor(mine[0].secret) !== c.hash) badSeats.push(c.seat);
  }
  for (const r of reveals) {
    if (!commits.some((c) => c.seat === r.seat) && !badSeats.includes(r.seat)) badSeats.push(r.seat);
  }
  return { ok: badSeats.length === 0, badSeats };
}
