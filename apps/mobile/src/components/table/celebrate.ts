/**
 * Which win celebration (bought in the Shop, equipped in Settings) plays over the table: only during the hold
 * after a hand the local player won, and only one they own and have put on. Pure, so the rule is tested.
 */
import { CELEBRATIONS, type CelebrationId } from '../../monetisation/cosmetics';

export function celebrationFor(
  result: { type: 'win' | 'draw'; wins: ReadonlyArray<{ seat: number }> } | null | undefined,
  mySeat: number,
  equipped: string | null | undefined,
  holding: boolean,
): CelebrationId | null {
  if (!holding || !result || result.type !== 'win' || !equipped) return null;
  if (!result.wins.some((w) => w.seat === mySeat)) return null;
  return (CELEBRATIONS as readonly string[]).includes(equipped) ? (equipped as CelebrationId) : null;
}
