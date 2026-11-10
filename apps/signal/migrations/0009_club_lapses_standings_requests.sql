-- 0009_club_lapses_standings_requests: the owner-lapse file, standings kept for members who left,
-- and the age of join requests.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- Accounts that owned the club while without The Four Winds Club, and when each one's lapse began:
-- [{ "userId": uuid, "lapsedAt": ms, "until": ms | null }]. A lapse belongs to the account, so
-- handing the club to a subscriber and taking it back does not start a new 7-day grace.
ALTER TABLE clubs ADD COLUMN owner_lapses jsonb NOT NULL DEFAULT '[]'::jsonb;
