-- 0018_rush_held_runs: a ranked Puzzle Rush run that solves more puzzles than the ceiling
-- (src/puzzles.ts RUSH_HOLD_SOLVED) is held off the Rush board until an admin confirms it
-- (GET /api/admin/puzzle-flags lists held runs; POST /api/admin/puzzle-flags/rush-runs/:id confirms
-- or rejects one). docs/API.md, "Plausible answer times". Applied by src/migrate.ts inside one
-- transaction. Never edit a migration that has shipped.

ALTER TABLE puzzle_rush_runs ADD COLUMN held boolean NOT NULL DEFAULT false;
CREATE INDEX puzzle_rush_runs_held_idx ON puzzle_rush_runs (finished_at) WHERE held;
