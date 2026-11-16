/**
 * The online result sheet's countdown to the next hand. The host deals it on its own once the intermission
 * runs out and says when (`intermissionDeadline`, on its clock like the turn deadline): the sheet shows
 * "Next hand in N s" and a screen reader hears it once per hand, never every second.
 */
import type { Translate } from '../../logic/translate';

/** The note under the result: the seconds left when the host said, else the general sentence (older hosts). */
export function nextHandNote(t: Translate, seconds: number | null): string {
  return seconds === null ? t('table.result.autoNext') : t('table.result.nextHandIn', { n: seconds });
}

/**
 * What to announce for this deadline: the spoken sentence the first time a deadline is seen, null for
 * the same deadline again (the countdown ticking) or when there is none.
 */
export function nextHandAnnouncement(t: Translate, deadline: number | null, seconds: number | null, announced: number | null): string | null {
  if (deadline === null || seconds === null || deadline === announced) return null;
  return t('table.result.nextHandInSpoken', { n: seconds });
}
