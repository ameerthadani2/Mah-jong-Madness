-- 0014_club_closed_matches: the record of matches an owner or admin closed before they finished.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- Oldest first, at most CLUB_LIMITS.closedMatchesKept (src/clubs.ts):
-- [{ "table", "label", "closedAt": ms, "closedBy": { "userId", "name" }, "handNumber",
--    "seats": [{ "seat", "name", "userId"?, "isBot", "points" }] }].
-- Shown to the club's members; a closed match never counts toward the standings.
ALTER TABLE clubs ADD COLUMN closed_matches jsonb NOT NULL DEFAULT '[]'::jsonb;
