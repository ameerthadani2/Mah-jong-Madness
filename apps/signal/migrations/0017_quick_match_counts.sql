-- 0017_quick_match_counts: the anti-collusion counts, kept across restarts: how often each pair of
-- accounts sat together at quick-match tables (src/matchmaking.ts), and each club's join allowance
-- per address and per device (src/clubs.ts). The limits themselves are unchanged.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- One row per pair of accounts (a < b) that shared a quick-match table. `shared_address` counts
-- the tables they joined from one IPv4 address. At most 20,000 rows: the pair seen together least
-- recently goes first.
CREATE TABLE quick_match_pairs (
  a              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  b              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tables         integer NOT NULL CHECK (tables >= 0),
  shared_address integer NOT NULL DEFAULT 0 CHECK (shared_address >= 0),
  last_at        timestamptz NOT NULL,
  PRIMARY KEY (a, b),
  CHECK (a < b)
);
CREATE INDEX quick_match_pairs_last_idx ON quick_match_pairs (last_at);
CREATE INDEX quick_match_pairs_tables_idx ON quick_match_pairs (tables DESC);

-- A club's daily join allowance for one address or one device: the token bucket as it stood at
-- `updated_at` (it refills from there). `key` is a salted hash of the address or install id, never
-- the address itself. A row a day old has refilled and is dropped.
CREATE TABLE club_join_allowances (
  kind       text NOT NULL CHECK (kind IN ('address', 'device')),
  club_code  text NOT NULL CHECK (length(club_code) BETWEEN 1 AND 16),
  key        text NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  tokens     double precision NOT NULL CHECK (tokens >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (kind, club_code, key)
);
CREATE INDEX club_join_allowances_updated_idx ON club_join_allowances (updated_at);

-- The salt for those hashes, made once per database.
CREATE TABLE counter_salt (
  id   integer PRIMARY KEY CHECK (id = 1),
  salt text NOT NULL
);
INSERT INTO counter_salt (id, salt) VALUES (1, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
