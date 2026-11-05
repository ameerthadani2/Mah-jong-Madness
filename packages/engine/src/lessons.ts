/**
 * Structured curriculum for Learn mode, assembled from one file per track under ./lessons.
 * Order matters: the app lists lessons in this order within each track.
 */
export * from './lessons/types';
import type { Lesson } from './lessons/types';
import { CORE_LESSONS } from './lessons/core';
import { EFFICIENCY_LESSONS } from './lessons/efficiency';
import { CALLING_LESSONS } from './lessons/calling';
import { VALUE_LESSONS } from './lessons/value';
import { DEFENCE_LESSONS } from './lessons/defence';
import { SCORING_LESSONS } from './lessons/scoring';

export const LESSONS: Lesson[] = [...CORE_LESSONS, ...EFFICIENCY_LESSONS, ...CALLING_LESSONS, ...VALUE_LESSONS, ...DEFENCE_LESSONS, ...SCORING_LESSONS];

/** Lessons of one track, in curriculum order. */
export function lessonsInTrack(track: Lesson['track']): Lesson[] {
  return LESSONS.filter((l) => l.track === track);
}
