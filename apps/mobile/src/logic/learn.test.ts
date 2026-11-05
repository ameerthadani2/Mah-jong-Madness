import { describe, expect, it } from 'vitest';
import { LESSON_TRACKS, LESSONS, lessonsInTrack } from '@mjm/engine';
import { groupByTrack, learnSummary, nextLesson, trackTitle } from './learn';

const TRACKS = [
  { id: 'a', name: 'Alpha', nameZh: '甲' },
  { id: 'b', name: 'Beta', nameZh: '乙' },
  { id: 'c', name: 'Gamma', nameZh: '丙' },
];
const L = [
  { id: 'b1', track: 'b', minutes: 4 },
  { id: 'a1', track: 'a', minutes: 3 },
  { id: 'a2', track: 'a', minutes: 5 },
  { id: 'b2', track: 'b', minutes: 6 },
  { id: 'a3', track: 'a', minutes: 2 },
];

describe('groupByTrack', () => {
  it('groups in track order, keeps lesson order, and drops empty tracks', () => {
    const g = groupByTrack(L, TRACKS, {});
    expect(g.map((x) => x.track.id)).toEqual(['a', 'b']);
    expect(g[0].lessons.map((l) => l.id)).toEqual(['a1', 'a2', 'a3']);
    expect(g[1].lessons.map((l) => l.id)).toEqual(['b1', 'b2']);
  });

  it('counts done/total, minutes left and the first unfinished lesson per track', () => {
    const g = groupByTrack(L, TRACKS, { a1: true, a3: true, b1: true, b2: true, gone: true });
    expect(g[0]).toMatchObject({ done: 2, total: 3, nextId: 'a2', minutesLeft: 5, complete: false });
    expect(g[1]).toMatchObject({ done: 2, total: 2, nextId: null, minutesLeft: 0, complete: true });
  });

  it('covers the real curriculum: six tracks in LESSON_TRACKS order, every lesson once', () => {
    const g = groupByTrack(LESSONS, LESSON_TRACKS, {});
    expect(g.map((x) => x.track.id)).toEqual(LESSON_TRACKS.map((t) => t.id));
    expect(g.reduce((n, x) => n + x.total, 0)).toBe(LESSONS.length);
    for (const x of g) {
      expect(x.lessons).toEqual(lessonsInTrack(x.track.id));
      expect(x.nextId).toBe(x.lessons[0].id);
    }
  });
});

describe('learnSummary', () => {
  it('is empty for a new player and points at the first lesson', () => {
    expect(learnSummary(L, TRACKS, {})).toEqual({ done: 0, total: 5, empty: true, allDone: false, startId: 'a1' });
  });

  it('ignores lessons that no longer exist and notices when everything is done', () => {
    expect(learnSummary(L, TRACKS, { gone: true }).empty).toBe(true);
    const all = Object.fromEntries(L.map((l) => [l.id, true]));
    expect(learnSummary(L, TRACKS, all)).toMatchObject({ done: 5, allDone: true, startId: null, empty: false });
  });
});

describe('nextLesson', () => {
  it('offers the next unfinished lesson in the same track', () => {
    expect(nextLesson(L, TRACKS, 'a1', { a1: true })).toEqual({ kind: 'track', lesson: L[2] });
    // a2 is already done: skip to a3.
    expect(nextLesson(L, TRACKS, 'a1', { a1: true, a2: true })).toEqual({ kind: 'track', lesson: L[4] });
    // Nothing after it, but an earlier lesson in the track is still open.
    expect(nextLesson(L, TRACKS, 'a3', { a3: true, a2: true })).toEqual({ kind: 'track', lesson: L[1] });
  });

  it('moves to the next track once this one is finished, wrapping round', () => {
    expect(nextLesson(L, TRACKS, 'a3', { a1: true, a2: true, a3: true })).toEqual({ kind: 'newTrack', lesson: L[0], trackId: 'b' });
    expect(nextLesson(L, TRACKS, 'b2', { b1: true, b2: true, a1: true })).toEqual({ kind: 'newTrack', lesson: L[2], trackId: 'a' });
  });

  it('has nothing to offer when every lesson is done or the id is unknown', () => {
    const all = Object.fromEntries(L.map((l) => [l.id, true]));
    expect(nextLesson(L, TRACKS, 'a1', all)).toEqual({ kind: 'none' });
    expect(nextLesson(L, TRACKS, 'nope', {})).toEqual({ kind: 'none' });
  });

  it('never offers the lesson just left, even when it was not passed', () => {
    const r = nextLesson(L, TRACKS, 'b1', {});
    expect(r).toEqual({ kind: 'track', lesson: L[3] });
  });

  it('walks the real basics track in order', () => {
    const basics = lessonsInTrack('basics');
    const r = nextLesson(LESSONS, LESSON_TRACKS, basics[0].id, { [basics[0].id]: true });
    expect(r).toEqual({ kind: 'track', lesson: basics[1] });
  });
});

describe('trackTitle', () => {
  it('shows both names in English and only the Chinese in zh-TW', () => {
    expect(trackTitle(LESSON_TRACKS[0], 'en')).toEqual({ main: 'Basics', aside: '入門' });
    expect(trackTitle(LESSON_TRACKS[0], 'zh-TW')).toEqual({ main: '入門', aside: null });
  });
});
