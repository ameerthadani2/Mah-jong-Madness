-- 0023_daily_held: a right daily answer the server timed under the review line (src/puzzles.ts
-- DAILY_REVIEW_MS, 7 s) is recorded but held off the daily board, and does not move the rating,
-- until an admin confirms it (GET /api/admin/puzzle-flags lists held answers; POST
-- /api/admin/puzzle-flags/daily/:id confirms or rejects one). docs/API.md, "Human-time floors".
-- A new column with a default: a database that already holds data takes it as is (no row is
-- held). Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

ALTER TABLE puzzle_results ADD COLUMN held boolean NOT NULL DEFAULT false;
CREATE INDEX puzzle_results_held_idx ON puzzle_results (created_at) WHERE held;
