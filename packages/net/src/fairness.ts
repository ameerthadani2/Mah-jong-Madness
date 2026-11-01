/**
 * Commit–reveal shuffle seed.
 *
 * Every seat (human or bot) picks a random secret and publishes sha256(secret)
 * to everyone before the hand. The host receives the secrets privately,
 * derives seed = sha256(secret_0 | secret_1 | secret_2 | secret_3) and deals.
 * After the hand the host publishes all secrets and the action log; each client
 * checks the commits, re-derives the seed, replays the log and compares hashes.
 *
 * Guarantee: no single participant — including the host — can choose or bias
 * the shuffle. Limitation: the host device learns the seed at deal time, so it
 * must be trusted not to peek (see docs/ARCHITECTURE.md for the neutral-host
 * option and the mental-mahjong roadmap).
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
