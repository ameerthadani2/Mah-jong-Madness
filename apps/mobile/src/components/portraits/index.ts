/**
 * The portrait cast. Each portrait is built once on first use and the same
 * element tree is reused by every Avatar and plate that shows it.
 */
import { buildPortrait, type PortraitArt } from './kit';
import { boss, chef, cowboy, gent, shades, student, uncle } from './men';
import { auntie, grandma, hoops, lady, sporty } from './women';

export const PORTRAIT_SPECS = { auntie, uncle, grandma, boss, lady, shades, hoops, cowboy, student, chef, sporty, gent } as const;
export type PortraitId = keyof typeof PORTRAIT_SPECS;

const built = new Map<PortraitId, PortraitArt>();

export function portraitArt(id: PortraitId): PortraitArt {
  let art = built.get(id);
  if (!art) {
    art = buildPortrait(PORTRAIT_SPECS[id]);
    built.set(id, art);
  }
  return art;
}
