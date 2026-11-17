-- 0012_puzzle_floors: human-time floors for the puzzle boards. A daily answer the server timed
-- under 3 seconds, or a Puzzle Rush run whose answers average under 1.5 seconds each, is recorded
-- but not ranked: it never appears on the daily or Rush board (docs/API.md, "Human-time floors").
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

ALTER TABLE puzzle_results ADD COLUMN ranked boolean NOT NULL DEFAULT true;
ALTER TABLE puzzle_rush_runs ADD COLUMN ranked boolean NOT NULL DEFAULT true;

-- The daily board reads ranked results only.
DROP INDEX IF EXISTS puzzle_results_daily_board_idx;
CREATE INDEX puzzle_results_daily_board_idx ON puzzle_results (puzzle_key, correct DESC, seconds, created_at, user_id) WHERE kind = 'daily' AND ranked;
