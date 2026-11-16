import React from 'react';
import { useT } from '../../i18n';
import { formatRatingChange, lastRatingChange, type RatingEntry } from '../../logic/rating';
import { Pill } from '../Ui';
import { useShownRating } from './usePuzzleServer';

/**
 * The puzzle rating as a pill: the server's when it can be read, else the one kept on the device.
 * With `showChange` it adds the last movement ("Rating 1016 (+16)"), which the puzzle screens show
 * right after an answer (for the server's rating, the change its last submission made).
 */
export function RatingPill({ rating, history, showChange, size }: { rating: number; history?: readonly RatingEntry[]; showChange?: boolean; size?: 'sm' | 'md' }) {
  const { t } = useT();
  const shown = useShownRating(rating, history ? lastRatingChange(history) : null);
  const change = showChange ? shown.change : null;
  const text = change !== null ? t('puzzles.rating.after', { n: shown.rating, delta: formatRatingChange(change) }) : t('puzzles.rating.pill', { n: shown.rating });
  return <Pill icon="target" size={size} text={text} tone={change === null ? 'info' : change >= 0 ? 'ok' : 'danger'} />;
}
