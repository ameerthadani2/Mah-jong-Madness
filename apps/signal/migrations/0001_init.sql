-- 0001_init: accounts, sessions, wallet, clubs, tables and results.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped;
-- add a new numbered file instead. Times are timestamptz; ids are uuid unless the table is an
-- append-only log, which uses a bigint identity.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- People. A guest is created on first online use; linking Apple/Google/Facebook makes it an account.
-- Deletion is soft (deleted_at plus scrubbed fields); a daily job hard-deletes after 30 days.
CREATE TABLE users (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('guest', 'account')),
  display_name text NOT NULL DEFAULT '',
  avatar       text,
  email        text,
  birth_year   smallint CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100),
  locale       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  merged_into  uuid REFERENCES users (id) ON DELETE SET NULL,
  CHECK (merged_into IS NULL OR merged_into <> id)
);
CREATE INDEX users_deleted_at_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;

-- One row per way of signing in. Provider 'guest' uses subject = user id and a peppered secret hash.
CREATE TABLE auth_identities (
  provider    text NOT NULL CHECK (provider IN ('guest', 'apple', 'google', 'facebook')),
  subject     text NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  secret_hash text,
  email       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, subject),
  CHECK ((provider = 'guest') = (secret_hash IS NOT NULL))
);
CREATE INDEX auth_identities_user_idx ON auth_identities (user_id);

CREATE TABLE devices (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  platform     text NOT NULL,
  app_build    text,
  push_token   text,
  locale       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_user_idx ON devices (user_id);
CREATE INDEX devices_push_token_idx ON devices (push_token) WHERE push_token IS NOT NULL;

-- Opaque bearer sessions; only sha256(pepper:token) is stored. After a rotation the old row's
-- revoked_at is set a few minutes ahead (the grace window) rather than to now.
CREATE TABLE sessions (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id    uuid REFERENCES devices (id) ON DELETE SET NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  rotated_from uuid REFERENCES sessions (id) ON DELETE SET NULL,
  revoked_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Financial records. wallet_ledger and purchases keep user_id without a foreign key so that
-- they outlive the hard deletion of an account (the id on its own identifies no one).
CREATE TABLE wallets (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  diamonds       integer NOT NULL DEFAULT 0 CHECK (diamonds >= 0),
  bonus_diamonds integer NOT NULL DEFAULT 0 CHECK (bonus_diamonds >= 0),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_ledger (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    uuid NOT NULL,
  delta      integer NOT NULL,
  bonus      integer NOT NULL DEFAULT 0,
  reason     text NOT NULL,
  ref        text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_ledger_user_idx ON wallet_ledger (user_id, created_at);

CREATE TABLE purchases (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        uuid NOT NULL,
  store          text NOT NULL,
  transaction_id text NOT NULL UNIQUE,
  product_id     text NOT NULL,
  price          numeric(14, 4),
  currency       text CHECK (currency IS NULL OR length(currency) = 3),
  event_id       text UNIQUE,
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchases_user_idx ON purchases (user_id, created_at);

-- Decided server-side from store notifications; expires_at NULL means it does not expire.
CREATE TABLE entitlements (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  entitlement text NOT NULL,
  expires_at  timestamptz,
  source      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, entitlement)
);

CREATE TABLE clubs (
  code        text PRIMARY KEY,
  owner_id    uuid NOT NULL REFERENCES users (id),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  season      integer NOT NULL DEFAULT 1 CHECK (season >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clubs_owner_idx ON clubs (owner_id);

-- display_name and avatar are the member's details as the club last saw them, so standings
-- need no join, and deletion can anonymise them to "Deleted player".
CREATE TABLE club_members (
  club_code       text NOT NULL REFERENCES clubs (code) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status          text NOT NULL DEFAULT 'member' CHECK (status IN ('member', 'pending')),
  display_name    text NOT NULL DEFAULT '',
  avatar          text,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  season_points   integer NOT NULL DEFAULT 0,
  lifetime_points integer NOT NULL DEFAULT 0,
  matches_played  integer NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  matches_won     integer NOT NULL DEFAULT 0 CHECK (matches_won >= 0),
  hands_won       integer NOT NULL DEFAULT 0 CHECK (hands_won >= 0),
  PRIMARY KEY (club_code, user_id)
);
CREATE INDEX club_members_user_idx ON club_members (user_id);

-- state holds the live listing (players, hand number, scores) shown in the club lobby.
CREATE TABLE club_tables (
  code        text PRIMARY KEY,
  club_code   text NOT NULL REFERENCES clubs (code) ON DELETE CASCADE,
  label       text NOT NULL DEFAULT '',
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'playing', 'finished')),
  state       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX club_tables_club_idx ON club_tables (club_code, created_at);

CREATE TABLE match_results (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_code   text NOT NULL,
  club_code   text,
  hand_count  integer NOT NULL CHECK (hand_count >= 0),
  scores      jsonb NOT NULL,
  players     jsonb NOT NULL,
  hands_won   jsonb NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX match_results_club_idx ON match_results (club_code, finished_at DESC) WHERE club_code IS NOT NULL;
CREATE INDEX match_results_room_idx ON match_results (room_code);

-- One serialised host per hosted table, restored at boot while status is not 'finished'.
CREATE TABLE table_snapshots (
  room_code  text PRIMARY KEY,
  club_code  text,
  status     text NOT NULL CHECK (status IN ('open', 'playing', 'finished')),
  snapshot   jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX table_snapshots_status_idx ON table_snapshots (status, updated_at);

CREATE TABLE puzzle_results (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         text NOT NULL,
  puzzle_key   text NOT NULL,
  correct      boolean NOT NULL,
  seconds      integer NOT NULL CHECK (seconds >= 0),
  rating_after integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX puzzle_results_user_idx ON puzzle_results (user_id, created_at);
CREATE INDEX puzzle_results_key_idx ON puzzle_results (kind, puzzle_key);
