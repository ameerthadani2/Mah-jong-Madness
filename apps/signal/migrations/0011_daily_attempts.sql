-- 0011_daily_attempts: the daily puzzle is timed by the server. Opening the puzzle starts an
-- attempt (one per account and date key, so reopening never restarts the clock) and answering
-- finishes it; the daily board's seconds are the server's time between the two.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

CREATE TABLE puzzle_daily_attempts (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  date_key    text NOT NULL CHECK (date_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  UNIQUE (user_id, date_key)
);
-- Attempts whose date has long closed are pruned by start time.
CREATE INDEX puzzle_daily_attempts_started_idx ON puzzle_daily_attempts (started_at);
