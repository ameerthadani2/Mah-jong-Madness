-- 0010_puzzle_boards: server-verified puzzle results, one puzzle rating per account, Puzzle Rush
-- runs the server times, and the leaderboards over them.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- Whether the account appears on public leaderboards (PATCH /api/me leaderboardVisible). A hidden
-- account still sees its own row.
ALTER TABLE users ADD COLUMN leaderboard_visible boolean NOT NULL DEFAULT true;

-- One puzzle rating per account, moved only by answers the server verified. `rated` counts them;
-- the rating board lists accounts with at least 20.
CREATE TABLE puzzle_ratings (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  rating     integer NOT NULL CHECK (rating BETWEEN 100 AND 4000),
  rated      integer NOT NULL DEFAULT 0 CHECK (rated >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX puzzle_ratings_board_idx ON puzzle_ratings (rating DESC, updated_at, user_id) WHERE rated >= 20;

-- A Puzzle Rush run: the server issues the seed and keeps the start time, and the run's score is
-- worked out from the server's clock when it is finished (once). Unfinished runs expire.
CREATE TABLE puzzle_rush_runs (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  seed        text NOT NULL CHECK (length(seed) BETWEEN 1 AND 64),
  started_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  finished_at timestamptz,
  solved      integer CHECK (solved >= 0),
  wrong       integer CHECK (wrong >= 0),
  seconds     integer CHECK (seconds >= 0),
  score       integer CHECK (score >= 0)
);
CREATE INDEX puzzle_rush_runs_user_idx ON puzzle_rush_runs (user_id, started_at);
-- Best run per account (DISTINCT ON user_id ... ORDER BY score DESC) and runs finished in a window.
CREATE INDEX puzzle_rush_runs_best_idx ON puzzle_rush_runs (user_id, score DESC, finished_at, id) WHERE finished_at IS NOT NULL;
CREATE INDEX puzzle_rush_runs_finished_idx ON puzzle_rush_runs (finished_at) WHERE finished_at IS NOT NULL;
CREATE INDEX puzzle_rush_runs_open_idx ON puzzle_rush_runs (expires_at) WHERE finished_at IS NULL;

-- One ranked daily attempt per account and date key, and the daily board's order.
CREATE UNIQUE INDEX puzzle_results_daily_once ON puzzle_results (user_id, puzzle_key) WHERE kind = 'daily';
CREATE INDEX puzzle_results_daily_board_idx ON puzzle_results (puzzle_key, correct DESC, seconds, created_at, user_id) WHERE kind = 'daily';
