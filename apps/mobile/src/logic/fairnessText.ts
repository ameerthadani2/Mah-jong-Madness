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
 * True when the final scores on show are the table's word alone: the match is over, and the hands
 * this phone verified do not lead to that end (it was away for some, or joined late). Every place
 * that shows final scores says so beside them (`fairness.endUnverified`).
 */
export function endUnverified(state: Pick<ClientState, 'matchOver' | 'matchEndVerified'> | null | undefined): boolean {
  return !!state && state.matchOver === true && state.matchEndVerified !== true;
}
