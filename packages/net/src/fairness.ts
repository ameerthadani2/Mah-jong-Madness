/**
 * Commit–reveal shuffle seed.
 *
 * Five shares go into every deal: one per seat 0–3 and the host's own (seat 4).
 * Each human player's client picks its secret; the host picks the bots' secrets,
 * any stand-in shares and its own. Every commitment commitFor(secret) is
 * published to the table, and a client reveals its secret only once it holds
 * all five. The host then derives
 *   seed = sha256('mjm-seed:' + matchId + ':' + hand + ':' + s0|s1|s2|s3|s4)
 * and deals. After the hand it publishes every secret, the restarts and the
 * action log; each client checks the commitments, re-derives the seed, replays
 * the log and compares hashes (see TableClient.verifyAudit).
 *
 * What this gives a player whose own share was used: nobody, the host included,
 * could choose the seed after seeing that share. What it does not give: the
 * host may restart a ceremony (every restart is published and bounded by the
 * number of human seats), may stand in for a seat (that seat's audit is then
 * only 'partial'), and learns the seed at deal time, so it is trusted not to
 * look at the wall during the hand. Online tables run on the game server.
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

export function makeSecret(): string {
  return randomHex(32);
}

export function commitFor(secret: string): string {
  return sha256Hex(`mjm-commit:${secret}`);
}

export function deriveSeed(matchId: string, reveals: Reveal[]): string {
  const ordered = [...reveals].sort((a, b) => a.seat - b.seat).map((r) => r.secret);
  return sha256Hex(`mjm-seed:${matchId}:${ordered.join('|')}`);
}

export function verifyReveals(commits: Commitment[], reveals: Reveal[]): { ok: boolean; badSeats: number[] } {
  const badSeats: number[] = [];
  for (const c of commits) {
    const r = reveals.find((x) => x.seat === c.seat);
    if (!r || commitFor(r.secret) !== c.hash) badSeats.push(c.seat);
  }
  return { ok: badSeats.length === 0, badSeats };
}
