-- 0020_club_join_hours: the hourly club join allowances, kept across restarts beside the daily
-- ones of 0017: how many clubs one address joined or asked to join in the last hour (across all
-- clubs), and how many accounts joined each club (one allowance for established accounts and one
-- for new ones, src/clubs.ts). The limits themselves are unchanged.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- One token bucket as it stood at `updated_at` (it refills from there). For `address`, `key` is a
-- salted hash of the address (with counter_salt, 0017), never the address itself; for `club` and
-- `club_new` it is the club code. A row an hour old has refilled and is dropped.
CREATE TABLE club_join_hours (
  kind       text NOT NULL CHECK (kind IN ('address', 'club', 'club_new')),
  key        text NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  tokens     double precision NOT NULL CHECK (tokens >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX club_join_hours_updated_idx ON club_join_hours (updated_at);
