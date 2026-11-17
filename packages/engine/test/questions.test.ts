/**
 * Questions (src/questions.ts): every field of every puzzle theme is either shown in the question
 * or deliberately withheld until the answer, and a question carries no withheld field. A field
 * added to a puzzle later fails here (and does not compile) until it is classified.
 */
import { describe, expect, it } from "vitest";
import {
  CLAIM_OPTION_FIELDS,
  claimQuestion,
  leakedFields,
  PUZZLE_FIELDS,
  PUZZLE_TYPES,
  puzzleOfType,
  puzzleQuestion,
  QUESTION_ONLY_FIELDS,
  withheldFields,
  type AnyPuzzle,
  type PuzzleDifficulty,
  type PuzzleType,
} from "../src/index";

const SEEDS = ["q-a", "q-b", "q-c", "q-d"];
const LEVELS: PuzzleDifficulty[] = [1, 2, 3];

/** Every puzzle the test looks at: four seeds of each theme at each difficulty. */
const puzzles: Array<{ p: AnyPuzzle; difficulty: PuzzleDifficulty }> =
  PUZZLE_TYPES.flatMap((type) =>
    LEVELS.flatMap((difficulty) =>
      SEEDS.map((seed) => ({
        p: puzzleOfType(type, `${seed}:${difficulty}`, difficulty),
        difficulty,
      })),
    ),
  );

/** The fields of `p` (and of a claim puzzle's options) that `PUZZLE_FIELDS` does not classify. */
function unclassified(
  p: Record<string, unknown> & { type: PuzzleType },
): string[] {
  const classes = PUZZLE_FIELDS[p.type] as Record<string, string>;
  const out = Object.keys(p).filter((k) => !(k in classes));
  if (p.type === "claim")
    for (const o of p.options as Array<Record<string, unknown>>)
      for (const k of Object.keys(o))
        if (!(k in CLAIM_OPTION_FIELDS) && !out.includes(`options.${k}`))
          out.push(`options.${k}`);
  return out;
}

describe("puzzle questions", () => {
  it("classifies every field of every theme, and every classified field occurs", () => {
    for (const { p } of puzzles)
      expect(unclassified(p as never), `${p.type} ${p.seed}`).toEqual([]);
    for (const type of PUZZLE_TYPES) {
      const seen = new Set(
        puzzles
          .filter((x) => x.p.type === type)
          .flatMap((x) => Object.keys(x.p)),
      );
      expect(
        Object.keys(PUZZLE_FIELDS[type]).filter((k) => !seen.has(k)),
        type,
      ).toEqual([]);
    }
    const optionKeys = new Set(
      puzzles.flatMap((x) =>
        x.p.type === "claim" ? x.p.options.flatMap((o) => Object.keys(o)) : [],
      ),
    );
    expect(
      Object.keys(CLAIM_OPTION_FIELDS).filter((k) => !optionKeys.has(k)),
    ).toEqual([]);
  });

  it("a field nobody classified is caught", () => {
    const p = puzzles.find((x) => x.p.type === "claim")!.p as never as Record<
      string,
      unknown
    > & { type: PuzzleType; options: Array<Record<string, unknown>> };
    expect(unclassified({ ...p, hint: "pong" })).toEqual(["hint"]);
    expect(
      unclassified({
        ...p,
        options: p.options.map((o) => ({ ...o, rank: 1 })),
      }),
    ).toEqual(["options.rank"]);
  });

  it("withholds the answer, the per-option analysis and the explanation of every theme", () => {
    const answerish = [
      "answers",
      "answer",
      "best",
      "rival",
      "options",
      "explanation",
      "explanationZh",
      "reasonKey",
      "patternKey",
      "bestShanten",
      "bestAcceptance",
    ];
    for (const type of PUZZLE_TYPES) {
      const classes = PUZZLE_FIELDS[type] as Record<string, string>;
      for (const k of answerish)
        if (k in classes)
          expect([k, classes[k]]).toEqual([
            k,
            k === "options" && type === "claim" ? "trimmed" : "withheld",
          ]);
    }
    expect(
      Object.entries(CLAIM_OPTION_FIELDS)
        .filter(([, c]) => c === "shown")
        .map(([k]) => k),
    ).toEqual(["id", "type", "kinds"]);
  });

  it("a question is exactly the shown fields and the difficulty, with no withheld field anywhere", () => {
    for (const { p, difficulty } of puzzles) {
      const q = puzzleQuestion(p, difficulty);
      const shown = Object.entries(
        PUZZLE_FIELDS[p.type] as Record<string, string>,
      )
        .filter(([, c]) => c !== "withheld")
        .map(([k]) => k);
      expect(Object.keys(q).sort(), `${p.type} ${p.seed}`).toEqual(
        [...new Set([...shown, ...QUESTION_ONLY_FIELDS])].sort(),
      );
      expect(leakedFields(q as never)).toEqual([]);
      for (const k of withheldFields(p.type))
        expect(JSON.stringify(q)).not.toContain(`"${k}"`);
      // Shown fields are the puzzle's own values.
      for (const k of shown)
        if (k !== "options")
          expect((q as unknown as Record<string, unknown>)[k]).toEqual(
            (p as unknown as Record<string, unknown>)[k],
          );
      expect(q.difficulty).toBe("difficulty" in p ? p.difficulty : difficulty);
      // The whole puzzle carries the withheld fields (the probe the server tests use finds them).
      expect(leakedFields(p as never).length).toBeGreaterThan(0);
    }
  });

  it("lists a claim question's choices in table order, whatever order the puzzle holds them in", () => {
    const claims = puzzles
      .filter((x) => x.p.type === "claim")
      .map((x) => x.p as Extract<AnyPuzzle, { type: "claim" }>);
    for (const p of claims) {
      const q = claimQuestion(p);
      expect(q.options.map((o) => o.id).sort()).toEqual(
        p.options.map((o) => o.id).sort(),
      );
      expect(
        claimQuestion({ ...p, options: [...p.options].reverse() }).options,
      ).toEqual(q.options);
      const order = ["pass", "chi", "pong", "kong", "hu"];
      const ranks = q.options.map((o) => order.indexOf(o.type));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  it("copies the table, so changing a question leaves its puzzle as it was", () => {
    const p = puzzles.find((x) => x.p.type === "defence")!.p as Extract<
      AnyPuzzle,
      { type: "defence" }
    >;
    const before = JSON.stringify(p);
    const q = puzzleQuestion(p, 2) as Extract<
      ReturnType<typeof puzzleQuestion>,
      { type: "defence" }
    >;
    q.hand.push(0);
    q.opponents[0].discards.push(0);
    expect(JSON.stringify(p)).toBe(before);
  });
});
