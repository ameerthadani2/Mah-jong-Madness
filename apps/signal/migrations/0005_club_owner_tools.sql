-- 0005_club_owner_tools: variant tables, the owner's plan lapse, and club bans.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- A table an owner or admin opened with rules other than the club's house rules. Variant tables
-- never count toward the club's standings.
ALTER TABLE club_tables ADD COLUMN variant boolean NOT NULL DEFAULT false;

-- When the server first saw that the owner no longer holds The Four Winds Club (only while the
-- store is live). After a 7-day grace the club keeps working but may have only one open table
-- until the owner renews or passes the club on. Null: the owner's plan is active (or not checked).
ALTER TABLE clubs ADD COLUMN owner_lapsed_at timestamptz;

-- Accounts the club's owner or admins have banned: they cannot rejoin the club, ask to join it,
-- or join its tables until they are unbanned. user_id has no foreign key on purpose: the ban
-- outlives a purge of the account it names (the id is never reused), and the club registry,
-- which writes these rows from memory, never trips over an account that has gone.
CREATE TABLE club_bans (
  club_code    text NOT NULL REFERENCES clubs (code) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  display_name text NOT NULL DEFAULT '',
  banned_by    text NOT NULL DEFAULT '',
  banned_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_code, user_id)
);
CREATE INDEX club_bans_user_idx ON club_bans (user_id);
