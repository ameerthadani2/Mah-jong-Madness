-- 0013_puzzle_flags: accounts flagged as automated by their puzzle results. A flagged (or
-- confirmed) account is on no puzzle board; it still sees its own row, marked. An admin clears or
-- confirms the flag (GET /api/admin/puzzle-flags, POST /api/admin/puzzle-flags/:userId).
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

CREATE TABLE puzzle_flags (
  user_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  status      text NOT NULL CHECK (status IN ('flagged', 'cleared', 'confirmed')),
  reason      text NOT NULL CHECK (length(reason) <= 500),
  flagged_at  timestamptz NOT NULL,
  reviewed_at timestamptz
);
CREATE INDEX puzzle_flags_status_idx ON puzzle_flags (status, flagged_at);
-- The flag check reads an account's latest finished runs.
CREATE INDEX puzzle_rush_runs_user_finished_idx ON puzzle_rush_runs (user_id, finished_at DESC) WHERE finished_at IS NOT NULL;
