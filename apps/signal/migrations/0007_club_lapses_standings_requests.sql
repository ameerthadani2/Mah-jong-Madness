-- 0007_club_lapses_standings_requests: the owner-lapse file, standings kept for members who left,
-- and the age of join requests.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- Accounts that owned the club while without The Four Winds Club, and when each one's lapse began:
-- [{ "userId": uuid, "lapsedAt": ms, "until": ms | null }]. A lapse belongs to the account, so
-- handing the club to a subscriber and taking it back does not start a new 7-day grace.
ALTER TABLE clubs ADD COLUMN owner_lapses jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Standings kept on file for an account that is no longer a member (it left, or was removed or
-- banned): hidden from the standings, and added back if the account rejoins, so leaving and
-- rejoining never wipes a score. season is the season season_points were scored in. The rows go
-- with the account when it is purged, like club_members.
CREATE TABLE club_former_members (
  club_code       text NOT NULL REFERENCES clubs (code) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  left_at         timestamptz NOT NULL DEFAULT now(),
  season          integer NOT NULL DEFAULT 1 CHECK (season >= 1),
  season_points   integer NOT NULL DEFAULT 0,
  lifetime_points integer NOT NULL DEFAULT 0,
  matches_played  integer NOT NULL DEFAULT 0 CHECK (matches_played >= 0),
  matches_won     integer NOT NULL DEFAULT 0 CHECK (matches_won >= 0),
  hands_won       integer NOT NULL DEFAULT 0 CHECK (hands_won >= 0),
  PRIMARY KEY (club_code, user_id)
);
CREATE INDEX club_former_members_user_idx ON club_former_members (user_id);

-- When a pending join request was made (status = 'pending' rows only). A request nobody answered
-- is dropped 30 days later. Null in rows written before requests expired: their 30 days start
-- when the server next loads the club.
ALTER TABLE club_members ADD COLUMN requested_at timestamptz;
