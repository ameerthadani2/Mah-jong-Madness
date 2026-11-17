-- 0016_table_ratings: one table rating per account, moved only by finished quick-match matches
-- between two or more humans (src/tableRating.ts).
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- `matches` counts the quick-match matches that moved it (the first 20 are provisional). The last
-- match that moved it, and by how much, is kept so the app can show the change after a quick match;
-- `last_match_id` also stops one match from being applied twice.
CREATE TABLE table_ratings (
  user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  rating        integer NOT NULL CHECK (rating BETWEEN 100 AND 4000),
  matches       integer NOT NULL DEFAULT 0 CHECK (matches >= 0),
  last_match_id text CHECK (length(last_match_id) <= 128),
  last_room     text CHECK (length(last_room) <= 32),
  last_change   integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
