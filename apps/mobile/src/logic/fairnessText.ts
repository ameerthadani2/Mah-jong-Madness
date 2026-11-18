/**
 * The table client explains an amber hand (a caveat) and a red one (a failure) with English
 * sentences of its own. The app shows each in the player's language by its key; a sentence this
 * build has no key for (a newer server or client) is shown as it came rather than hidden.
 */
import { auditFailure, caveatKey, type ClientState } from '@mjm/net';
import type { Translate } from './translate';

/** A caveat from the table client in the player's language. */
export function caveatText(t: Translate, text: string): string {
  const key = caveatKey(text);
  return key ? t(`fairness.caveat.${key}`) : text;
}

/** A failed check from the table client in the player's language, with the turn, seat or count it names. */
export function failureText(t: Translate, text: string): string {
  const known = auditFailure(text);
  return known ? t(`fairness.failure.${known.key}`, known.params) : text;
}

/**
 * The match's count of claims (Pong, Chow, Kong) the table passed for this seat while its link was
 * down, in the player's language, or null when there were none. An honest drop costs one now and
 * then; a server that cuts the link whenever the player could claim shows up here as a pattern.
 */
export function claimsPassedText(t: Translate, state: Pick<ClientState, 'claimsPassedAway'> | null | undefined): string | null {
  const count = (state?.claimsPassedAway ?? []).filter((p) => p.late !== true).length;
  return count > 0 ? t('fairness.claimsPassedAway', { count }) : null;
}

/**
 * The same for claims passed on a turn that reached this phone late, whether or not its link dropped
 * (the turn was judged as a drop, but is not said to be one), or null when there were none.
 */
export function claimsPassedLateText(t: Translate, state: Pick<ClientState, 'claimsPassedAway'> | null | undefined): string | null {
  const count = (state?.claimsPassedAway ?? []).filter((p) => p.late === true).length;
  return count > 0 ? t('fairness.claimsPassedLate', { count }) : null;
}

/**
 * The match's count of this seat's turns that reached the phone late (more than half the turn clock
 * gone, `lateCountMs` in the table client), out of the turns it could measure, in the player's
 * language, or null when none did. Never a verdict: a stall or a slow connection costs some, and a
 * hand fails or turns amber only past 17 s. A count that rises with nearly every turn is what a
 * server that shows every turn late, inside those 17 s, leaves at the fast speeds.
 */
export function turnsLateText(t: Translate, state: Pick<ClientState, 'turnsShownLate'> | null | undefined): string | null {
  const recs = state?.turnsShownLate ?? [];
  const count = recs.reduce((n, r) => n + r.late.length, 0);
  const total = recs.reduce((n, r) => n + r.of, 0);
  return count > 0 ? t('fairness.turnsLate', { count, total }) : null;
}

/**
 * True when the final scores on show are the table's word alone: the match is over, and the hands
 * this phone verified do not lead to that end (it was away for some, or joined late), or the last
 * hand's own check says it could not vouch for the scores that hand started from. Every place
 * that shows final scores says so beside them (`fairness.endUnverified`).
 */
export function endUnverified(state: (Pick<ClientState, 'matchOver' | 'matchEndVerified'> & { auditCaveats?: readonly string[] }) | null | undefined): boolean {
  if (!state || state.matchOver !== true) return false;
  if (state.matchEndVerified !== true) return true;
  // The last hand says this phone was not shown the hands before it, so it could not check the scores that
  // hand started from: final scores reached through it are not checked either, whatever the last hand added.
  return (state.auditCaveats ?? []).some((c) => caveatKey(c) === 'gap');
}
