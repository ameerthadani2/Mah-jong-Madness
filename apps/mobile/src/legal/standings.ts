/**
 * Club standings: points only (no chips, no monetary value), kept per season and for all
 * time. "Start new season" (club owners) archives the season column on the server and
 * starts it again from zero; lifetime totals keep counting. Pure, so it is unit-tested.
 */
import type { ClubMember } from '../api/clubs';

export type StandingsView = 'season' | 'lifetime';

type Scored = Pick<ClubMember, 'points' | 'seasonPoints' | 'lifetimePoints'>;

/** The member's points for a view. A server without seasons sends only `points`, used for both. */
export function standingPoints(m: Scored, view: StandingsView): number {
  const v = view === 'season' ? (m.seasonPoints ?? m.points) : (m.lifetimePoints ?? m.points);
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Highest first; ties by more matches won, then by name, so the order is stable. */
export function sortStandings<M extends Scored & Pick<ClubMember, 'matchesWon' | 'name'>>(members: readonly M[], view: StandingsView): M[] {
  return [...members].sort((a, b) => standingPoints(b, view) - standingPoints(a, view) || (b.matchesWon ?? 0) - (a.matchesWon ?? 0) || a.name.localeCompare(b.name));
}

/** Only the owner may start a new season. */
export function canStartSeason(role: ClubMember['role'] | undefined): boolean {
  return role === 'owner';
}
