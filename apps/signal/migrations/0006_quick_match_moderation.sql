-- 0006_quick_match_moderation: blocks between players, account bans and mutes, report outcomes.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- A banned account cannot sign in, refresh, open a socket or enter the quick-match queue. The
-- reason is for moderators only (never shown to other players).
ALTER TABLE users ADD COLUMN banned_at timestamptz;
ALTER TABLE users ADD COLUMN ban_reason text CHECK (ban_reason IS NULL OR length(ban_reason) <= 500);
-- While this is in the future the account's chat lines and emotes are dropped at every table.
ALTER TABLE users ADD COLUMN muted_until timestamptz;
CREATE INDEX users_muted_idx ON users (muted_until) WHERE muted_until IS NOT NULL;

-- One player blocking another: the app hides the blocked player's chat and emotes, and quick
-- match never seats the two at one table (in either direction). Both rows go with a purge of
-- either account; an account merge moves them to the surviving account.
CREATE TABLE user_blocks (
  blocker_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX user_blocks_blocked_idx ON user_blocks (blocked_id);

-- What a moderator did with a report, and when.
ALTER TABLE reports ADD COLUMN resolution text CHECK (resolution IS NULL OR resolution IN ('dismiss', 'warn', 'ban', 'mute'));
ALTER TABLE reports ADD COLUMN resolved_at timestamptz;
