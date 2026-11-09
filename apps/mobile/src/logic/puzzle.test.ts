import { describe, expect, it } from 'vitest';
import { claimPuzzle, dailyPuzzle, dailySeed, defencePuzzle, discardPuzzle, kindInfo, PUZZLE_TYPES, puzzleOfType, valuePuzzle, waitsPuzzle, type AnyPuzzle, type ClaimPuzzle, type PuzzleType } from '@mjm/engine';
import { en, zhTW } from '../i18n/locales';
import { checkPuzzleAnswer, claimButtons, claimOutcomeKey, dailyDifficulty, defenceSeats, defenceVerdicts, explanationFor, percent, PUZZLE_TYPE_KEYS, puzzleDifficultyOf, puzzleStatus, reasonTitleKey, seatRelation, SEAT_KEYS, taiFigure, threatKey, tileName, valueProjections } from './puzzle';

const lookup = (tree: unknown, key: string): unknown => key.split('.').reduce<unknown>((n, part) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[part] : undefined), tree);
const inBothLocales = (key: string) => typeof lookup(en, key) === 'string' && typeof lookup(zhTW, key) === 'string';

describe('puzzleStatus', () => {
  it('reads shanten 0 on a 17-tile hand as one discard from ready, not ready', () => {
    expect(puzzleStatus(0)).toEqual({ key: 'puzzles.view.status.oneFromReady' });
  });

  it('describes hands further away', () => {
    expect(puzzleStatus(1)).toEqual({ key: 'puzzles.view.status.leaves', params: { n: 1 } });
    expect(puzzleStatus(3)).toEqual({ key: 'puzzles.view.status.leaves', params: { n: 3 } });
  });

  it('handles a complete hand', () => {
    expect(puzzleStatus(-1)).toEqual({ key: 'puzzles.view.status.complete' });
  });

  it('returns keys only, never English text', () => {
    for (const s of [-1, 0, 2]) {
      const r = puzzleStatus(s);
      expect(r.key).toMatch(/^puzzles\./);
      expect(inBothLocales(r.key)).toBe(true);
    }
  });

  it('agrees with the engine: a shanten-0 puzzle has a discard that leaves the hand ready', () => {
    let found = false;
    for (let i = 0; i < 200 && !found; i++) {
      const p = discardPuzzle(`status-${i}`, 3);
      if (p.currentShanten !== 0) continue;
      found = true;
      expect(p.hand.length).toBe(17);
      expect(p.bestShanten).toBe(0);
      expect(puzzleStatus(p.currentShanten).key).toBe('puzzles.view.status.oneFromReady');
    }
    expect(found).toBe(true);
  });
});

describe('theme labels', () => {
  it('has a label for all five themes in both locales', () => {
    expect(Object.keys(PUZZLE_TYPE_KEYS).sort()).toEqual([...PUZZLE_TYPES].sort());
    for (const type of PUZZLE_TYPES) expect(inBothLocales(PUZZLE_TYPE_KEYS[type])).toBe(true);
  });
});

/** The right answer of each theme, in the shape the view passes it. */
function rightAnswer(p: AnyPuzzle) {
  switch (p.type) {
    case 'discard':
      return p.answers[0];
    case 'waits':
      return p.answers;
    case 'defence':
    case 'value':
      return p.answer;
    case 'claim':
      return p.answer.id;
  }
}

function wrongAnswer(p: AnyPuzzle) {
  switch (p.type) {
    case 'discard':
      return p.hand.find((k) => !p.answers.includes(k))!;
    case 'waits':
      return p.answers.slice(1);
    case 'defence':
      return p.options.find((o) => !p.answers.includes(o.kind))!.kind;
    case 'value':
      return p.rival;
    case 'claim':
      return p.options.find((o) => !p.answers.includes(o.id))!.id;
  }
}

describe('checkPuzzleAnswer', () => {
  for (const type of PUZZLE_TYPES) {
    it(`dispatches ${type} puzzles to their own checker`, () => {
      for (let i = 0; i < 4; i++) {
        const p = puzzleOfType(type, `check-${type}-${i}`, (1 + (i % 3)) as 1 | 2 | 3);
        expect(p.type).toBe(type);
        expect(checkPuzzleAnswer(p, rightAnswer(p))).toBe(true);
        expect(checkPuzzleAnswer(p, wrongAnswer(p))).toBe(false);
      }
    });
  }

  it('accepts every accepted answer of the table themes, not only the best one', () => {
    let several = 0;
    for (let i = 0; i < 60; i++) {
      for (const p of [defencePuzzle(`many-${i}`, 3), valuePuzzle(`many-${i}`, 2), claimPuzzle(`many-${i}`, 2)]) {
        const ids: Array<number | string> = p.answers;
        if (ids.length > 1) several++;
        for (const a of ids) expect(checkPuzzleAnswer(p, a)).toBe(true);
      }
    }
    expect(several).toBeGreaterThan(0);
  });

  it('accepts a claim option object as well as its id', () => {
    const p = claimPuzzle('claim-object', 2);
    expect(checkPuzzleAnswer(p, p.answer)).toBe(true);
  });

  it('treats an answer of the wrong shape as wrong', () => {
    const d = discardPuzzle('shape', 1);
    expect(checkPuzzleAnswer(d, [d.answers[0]])).toBe(false);
    const w = waitsPuzzle('shape', 1);
    expect(checkPuzzleAnswer(w, w.answers[0])).toBe(false);
    const c = claimPuzzle('shape', 1);
    expect(checkPuzzleAnswer(c, 3)).toBe(false);
    expect(checkPuzzleAnswer(c, [3])).toBe(false);
  });
});

describe('difficulty', () => {
  it('reads the field on the table puzzles and falls back for discard and waits', () => {
    expect(puzzleDifficultyOf(defencePuzzle('d', 3), 1)).toBe(3);
    expect(puzzleDifficultyOf(valuePuzzle('v', 1), 3)).toBe(1);
    expect(puzzleDifficultyOf(discardPuzzle('x', 3), 2)).toBe(2);
    expect(puzzleDifficultyOf(waitsPuzzle('x', 3), 1)).toBe(1);
  });

  it('matches the difficulty dailyPuzzle uses on every weekday', () => {
    for (let day = 1; day <= 7; day++) {
      const date = new Date(Date.UTC(2026, 10, day));
      expect(dailyPuzzle(date)).toEqual(discardPuzzle(dailySeed(date), dailyDifficulty(date)));
    }
    expect(dailyDifficulty(new Date(Date.UTC(2026, 10, 7)))).toBe(3); // Saturday
    expect(dailyDifficulty(new Date(Date.UTC(2026, 10, 2)))).toBe(1); // Monday
    expect(dailyDifficulty(new Date(Date.UTC(2026, 10, 3)))).toBe(2); // Tuesday
  });
});

describe('seats', () => {
  it('names seats by where they sit from you', () => {
    expect(seatRelation(1)).toBe('right');
    expect(seatRelation(2)).toBe('opposite');
    expect(seatRelation(3)).toBe('left');
    expect(() => seatRelation(0)).toThrow();
    expect(lookup(zhTW, SEAT_KEYS.left)).toBe('上家');
    expect(lookup(zhTW, SEAT_KEYS.opposite)).toBe('對家');
    expect(lookup(zhTW, SEAT_KEYS.right)).toBe('下家');
    for (const k of Object.values(SEAT_KEYS)) expect(inBothLocales(k)).toBe(true);
  });
});

describe('text helpers', () => {
  it('picks the explanation and tile names in the app language', () => {
    const p = defencePuzzle('text', 1);
    expect(explanationFor(p, 'en')).toBe(p.explanation);
    expect(explanationFor(p, 'zh-TW')).toBe(p.explanationZh);
    expect(tileName(0, 'en')).toBe(kindInfo(0).nameEn);
    expect(tileName(0, 'zh-TW')).toBe(kindInfo(0).nameZh);
  });

  it('has a headline in both locales for every reason key the engine gives', () => {
    const seen = new Set<string>();
    for (const type of ['defence', 'claim', 'value'] as PuzzleType[]) {
      for (let i = 0; i < 24; i++) {
        const p = puzzleOfType(type, `reason-${i}`, (1 + (i % 3)) as 1 | 2 | 3);
        if ('reasonKey' in p) seen.add(p.reasonKey);
      }
    }
    expect(seen.size).toBeGreaterThan(5);
    for (const reason of seen) {
      const key = reasonTitleKey(reason);
      expect(key, reason).not.toBeNull();
      expect(inBothLocales(key!), reason).toBe(true);
    }
    expect(reasonTitleKey('puzzle.unknown')).toBeNull();
  });
});

describe('claimButtons', () => {
  const puzzles: ClaimPuzzle[] = Array.from({ length: 30 }, (_, i) => claimPuzzle(`buttons-${i}`, (1 + (i % 3)) as 1 | 2 | 3));

  it('offers one button per legal option, pass first and 胡 last', () => {
    for (const p of puzzles) {
      const b = claimButtons(p, 'en');
      expect(b.map((x) => x.id).sort()).toEqual(p.options.map((o) => o.id).sort());
      expect(b[0].type).toBe('pass');
      const rank = { pass: 0, chi: 1, pong: 2, kong: 3, hu: 4 };
      for (let i = 1; i < b.length; i++) expect(rank[b[i].type]).toBeGreaterThanOrEqual(rank[b[i - 1].type]);
      expect(b.filter((x) => checkPuzzleAnswer(p, x.option))).toHaveLength(p.answers.length);
      expect(b.filter((x) => checkPuzzleAnswer(p, x.id)).map((x) => x.id).sort()).toEqual(p.answers.slice().sort());
      // Once answered, each button says where it leaves the hand.
      for (const x of b) expect(inBothLocales(claimOutcomeKey(x.option).key)).toBe(true);
    }
  });

  it('pictures the set each claim makes, the discard included', () => {
    let chi = 0;
    for (const p of puzzles) {
      for (const b of claimButtons(p, 'zh-TW')) {
        expect(inBothLocales(b.label.key)).toBe(true);
        if (b.type === 'pass') expect(b.kinds).toEqual([]);
        if (b.type === 'pong') expect(b.kinds).toEqual([p.discard, p.discard, p.discard]);
        if (b.type === 'kong') expect(b.kinds).toHaveLength(4);
        if (b.type === 'hu') expect(b.kinds).toEqual([p.discard]);
        if (b.type === 'chi') {
          chi++;
          expect(b.kinds).toContain(p.discard);
          expect(b.kinds[2] - b.kinds[0]).toBe(2);
          expect(b.label.params?.tile).toBe(kindInfo(p.discard).nameZh);
        }
      }
    }
    expect(chi).toBeGreaterThan(0);
  });

  it('offers 吃 only on a discard from your left', () => {
    for (const p of puzzles) if (claimButtons(p, 'en').some((b) => b.type === 'chi')) expect(seatRelation(p.from)).toBe('left');
  });
});

describe('defenceSeats', () => {
  it('lists the three other seats with the threat first', () => {
    for (let i = 0; i < 6; i++) {
      const p = defencePuzzle(`seats-${i}`, (1 + (i % 3)) as 1 | 2 | 3);
      const seats = defenceSeats(p);
      expect(seats.map((s) => s.seat).sort()).toEqual([1, 2, 3]);
      expect(seats[0].seat).toBe(p.threatSeat);
      expect(seats[0].threat).toBe(true);
      expect(seats.filter((s) => s.threat)).toHaveLength(1);
      expect(seats[0].melds.length).toBeGreaterThanOrEqual(3);
      const tk = threatKey(p);
      expect(inBothLocales(tk.key)).toBe(true);
      expect(tk.params?.n).toBe(seats[0].melds.length);
    }
  });
});

describe('defenceVerdicts', () => {
  it('lists every shape-keeping discard, accepted ones first, with its exact deal-in chance', () => {
    for (let i = 0; i < 9; i++) {
      const p = defencePuzzle(`verdicts-${i}`, (1 + (i % 3)) as 1 | 2 | 3);
      const v = defenceVerdicts(p);
      expect(v.map((x) => x.kind).sort((a, b) => a - b)).toEqual(p.options.filter((o) => o.shanten === p.bestShanten).map((o) => o.kind));
      expect(v.filter((x) => x.accepted).map((x) => x.kind).sort((a, b) => a - b)).toEqual(p.answers.slice().sort((a, b) => a - b));
      const firstWorse = v.findIndex((x) => !x.accepted);
      expect(v.slice(0, firstWorse).every((x) => x.accepted)).toBe(true);
      expect(v.every((x) => x.chance >= 0 && x.chance <= 1)).toBe(true);
    }
    expect(percent(0.0234)).toBe('2.3%');
    expect(percent(0)).toBe('0.0%');
  });
});

describe('valueProjections', () => {
  it('shows every ready discard, the best first, with the expected and the best case', () => {
    for (let i = 0; i < 9; i++) {
      const p = valuePuzzle(`proj-${i}`, (1 + (i % 3)) as 1 | 2 | 3);
      const cards = valueProjections(p);
      expect(cards[0].role).toBe('best');
      expect(cards[0].kind).toBe(p.answer);
      expect(cards[0].share).toBe(100);
      const rival = cards.find((c) => c.kind === p.rival)!;
      expect(rival.role).toBe('worse');
      expect(rival.share).toBeLessThan(90);
      for (const c of cards) {
        expect(c.role === 'worse').toBe(!p.answers.includes(c.kind));
        expect(c.expectedTai).toBeLessThanOrEqual(c.bestTai + 1e-9);
        expect(c.acceptance).toBeGreaterThan(0);
      }
      if (p.patternKey) expect(cards[0].items.some((it) => it.key === p.patternKey)).toBe(true);
    }
    expect(taiFigure(2)).toBe('2');
    expect(taiFigure(2.25)).toBe('2.3');
  });
});

