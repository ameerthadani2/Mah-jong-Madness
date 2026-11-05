import React from 'react';
import { useT } from '../../i18n';
import { formatRatingChange, lastRatingChange, type RatingEntry } from '../../logic/rating';
import { Pill } from '../Ui';

/**
 * The puzzle rating as a pill. With `showChange` it adds the last answer's movement
 * ("Rating 1016 (+16)"), which the puzzle screens show right after an answer.
 */
export function RatingPill({ rating, history, showChange, size }: { rating: number; history?: readonly RatingEntry[]; showChange?: boolean; size?: 'sm' | 'md' }) {
  const { t } = useT();
  const change = showChange && history ? lastRatingChange(history) : null;
  const text = change !== null ? t('puzzles.rating.after', { n: rating, delta: formatRatingChange(change) }) : t('puzzles.rating.pill', { n: rating });
  return <Pill icon="target" size={size} text={text} tone={change === null ? 'info' : change >= 0 ? 'ok' : 'danger'} />;
}
