/**
 * The Learn screen's curriculum view: lessons grouped by track in LESSON_TRACKS order, progress per track,
 * the lesson to start next in each track, and what to offer when a lesson ends. Pure, so the grouping and the
 * "what next" rules are unit-tested; the screen only draws.
 */

export interface TrackLike<T extends string = string> {
  id: T;
  name: string;
  nameZh: string;
}

export interface LessonLike<T extends string = string> {
  id: string;
  track: T;
  minutes: number;
}

export type DoneMap = Readonly<Record<string, boolean | undefined>>;

export interface TrackGroup<L extends LessonLike, T extends TrackLike> {
  track: T;
  lessons: L[];
  done: number;
  total: number;
  /** Minutes left in the track's unfinished lessons. */
  minutesLeft: number;
  /** The first unfinished lesson (highlighted on the Learn screen), or null when the track is complete. */
  nextId: string | null;
  complete: boolean;
}

/** Lessons grouped by track, tracks in the given order; empty tracks are left out, lesson order is kept. */
export function groupByTrack<L extends LessonLike, T extends TrackLike>(lessons: readonly L[], tracks: readonly T[], done: DoneMap): Array<TrackGroup<L, T>> {
  return tracks
    .map((track) => {
      const mine = lessons.filter((l) => l.track === track.id);
      const unfinished = mine.filter((l) => !done[l.id]);
      return {
        track,
        lessons: mine,
        done: mine.length - unfinished.length,
        total: mine.length,
        minutesLeft: unfinished.reduce((n, l) => n + l.minutes, 0),
        nextId: unfinished[0]?.id ?? null,
        complete: mine.length > 0 && unfinished.length === 0,
      };
    })
    .filter((g) => g.total > 0);
}

export interface LearnSummary {
  done: number;
  total: number;
  /** Nothing finished yet: the screen shows its welcome instead of progress. */
  empty: boolean;
  /** Every lesson finished. */
  allDone: boolean;
  /** Where a new player should start: the first unfinished lesson in curriculum order. */
  startId: string | null;
}

/** Overall progress; done entries for lessons that no longer exist are not counted. */
export function learnSummary<L extends LessonLike, T extends TrackLike>(lessons: readonly L[], tracks: readonly T[], done: DoneMap): LearnSummary {
  const groups = groupByTrack(lessons, tracks, done);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const finished = groups.reduce((n, g) => n + g.done, 0);
  return { done: finished, total, empty: finished === 0, allDone: total > 0 && finished === total, startId: groups.find((g) => g.nextId)?.nextId ?? null };
}

export type NextLesson<L extends LessonLike> =
  /** The next lesson in the same track. */
  | { kind: 'track'; lesson: L }
  /** This track is finished: the first unfinished lesson of a later (or earlier) track. */
  | { kind: 'newTrack'; lesson: L; trackId: L['track'] }
  /** Nothing left to learn. */
  | { kind: 'none' };

/**
 * What the lesson end screen offers after `id`: the first unfinished lesson after it in its track, else the
 * first unfinished one before it in the track, else the first unfinished lesson of the following tracks
 * (wrapping round to the earlier ones). `done` should already include the lesson just finished.
 */
export function nextLesson<L extends LessonLike, T extends TrackLike>(lessons: readonly L[], tracks: readonly T[], id: string, done: DoneMap): NextLesson<L> {
  const current = lessons.find((l) => l.id === id);
  if (!current) return { kind: 'none' };
  const inTrack = lessons.filter((l) => l.track === current.track);
  const at = inTrack.findIndex((l) => l.id === id);
  const sameTrack = [...inTrack.slice(at + 1), ...inTrack.slice(0, at)].find((l) => !done[l.id] && l.id !== id);
  if (sameTrack) return { kind: 'track', lesson: sameTrack };
  const order = tracks.map((t) => t.id);
  const ti = order.indexOf(current.track);
  const rest = ti < 0 ? order : [...order.slice(ti + 1), ...order.slice(0, ti)];
  for (const tid of rest) {
    const l = lessons.find((x) => x.track === tid && !done[x.id]);
    if (l) return { kind: 'newTrack', lesson: l, trackId: l.track };
  }
  return { kind: 'none' };
}

/** A track's name for the locale: English shows the Chinese name beside it, zh-TW shows only the Chinese. */
export function trackTitle(track: TrackLike, locale: string): { main: string; aside: string | null } {
  return locale === 'zh-TW' ? { main: track.nameZh, aside: null } : { main: track.name, aside: track.nameZh };
}
