# The adversary fuzzer

A malicious server, programmed by a seed, between the real `TableHost` and the real `TableClient` of the player at
seat 0, with an oracle that knows what really happened. It looks for the combinations of moves that the rounds of
checks found by hand: a frame withheld, a link cut at the right moment, a notice, a forged move, a late refusal, an app
restart, a table said to be gone.

## Files

- `scenario.ts`: what a scenario is (a table, a player, a list of events) and the vocabulary of events.
- `generate.ts`: scenarios drawn from a seed, honest or mixed with attacks.
- `sim.ts`: the table on a fake clock, the player's phone and the app around its client (saves 0.4 s after a change,
  restores, the archive of tables that left Home by match, the red hands kept apart, the journal of moves, the lookup
  by match at a welcome; what the app holds in memory apart from what its storage holds, which a cold start reads and
  a failing storage stops writing), built from the app's own logic in `apps/mobile/src/logic` where the code has it.
- `server.ts`: the server, doing what each event says.
- `truth.ts`: the ground truth of a run (every move sent, every move forged, every frame and what reached the phone).
- `oracle.ts`: which hands were cheated, the stated limits (`EXCEPTIONS`, quoted from docs/FAIRNESS.md), and the
  properties every run must keep.
- `fuzz.ts`: runs one scenario, shrinks a failing one, prints a failure with the command that replays it.
- `known.ts`: the gaps the checks found, each as a fixed scenario with a control, and the stated limits.
- `soak.ts`: the long runs.
- `adversary.test.ts`, `adversary-gaps.test.ts`, `adversary-rules.test.ts` (with `ci.ts`): a fixed sample in CI, in three
  files the test runner runs side by side: honest and generated seeds; the gaps found, closed and open; the stated
  limits and the controls. Under coverage the seed samples are smaller.

## The properties

- A hand in which the player was cheated is never green. It is amber only where docs/FAIRNESS.md states that case as a
  limit. The end of the match is not shown verified, unless every cheat in it is a stated limit the charter does not
  keep the end unverified for.
- A hand the phone once showed red stays red.
- A scenario made only of honest events never shows red.

## Running it

    npx vitest run test/adversary                      # in packages/net: the CI sample
    npm run fuzz:fair -w @mjm/net -- --from 1 --to 5000 --mode both --workers 2
    npm run fuzz:fair -w @mjm/net -- --replay '<the JSON a failure printed>' --timeline
    npm run fuzz:fair -w @mjm/net -- --seed 1234 --mode mixed --timeline

`--out f.jsonl` keeps one line per failing scenario (seed, classes, the shrunk scenario). `ADVERSARY_TREE=<folder>` runs
another copy of the code (packages/net, packages/engine and apps/mobile/src/logic, as `git archive` gives them).
`ADVERSARY_OLD_TREE=<folder>` loads the build an app update replaces, so honest scenarios can hold an update
(`--update`). `ADVERSARY_JOURNAL=0` models the app without its journal of moves.

## Open gaps

`ci.ts` lists the gaps this code still has (`OPEN_GAPS`), and `adversary.test.ts` the generated seeds that find one
(`OPEN_MIXED_SEEDS`): each runs as an expected failure, so the sample stays green while they are open and turns red the
day one is closed; move it to the closed ones then. A gap the charter comes to state as a limit becomes a `limit` case
in `known.ts`, with its exception in `oracle.ts`.

## When the charter changes

Each stated limit is quoted word for word. When docs/FAIRNESS.md rewords one, the first test fails: copy the new words
into `EXCEPTIONS` in oracle.ts, and change what the limit covers if the meaning changed. A limit the code no longer
needs (a gap closed for good) is removed from both.

## When the generator changes

The seeds of the CI sample name scenarios of this `generate.ts`: a change to the generator gives them other scenarios,
so pick them again with a long run after one.
