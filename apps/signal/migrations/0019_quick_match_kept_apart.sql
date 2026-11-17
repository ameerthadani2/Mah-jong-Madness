-- 0019_quick_match_kept_apart: a pair of accounts that shared an IPv4 address at three quick-match
-- tables in one UTC day is kept apart at quick match from then on (src/matchmaking.ts; the
-- shared-address preference becomes a hard separation for that pair). `shared_day` and
-- `shared_today` count that day's shared tables; a kept-apart row is never pruned for room.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

ALTER TABLE quick_match_pairs ADD COLUMN shared_day date;
ALTER TABLE quick_match_pairs ADD COLUMN shared_today integer NOT NULL DEFAULT 0 CHECK (shared_today >= 0);
ALTER TABLE quick_match_pairs ADD COLUMN kept_apart boolean NOT NULL DEFAULT false;
CREATE INDEX quick_match_pairs_apart_a_idx ON quick_match_pairs (a) WHERE kept_apart;
CREATE INDEX quick_match_pairs_apart_b_idx ON quick_match_pairs (b) WHERE kept_apart;
