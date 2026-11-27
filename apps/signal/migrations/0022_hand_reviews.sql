-- 0022_hand_reviews: the free hand-review allowance, counted on the server for each account
-- (src/reviews.ts) as the Puzzle Rush meter is: one row per hand an account opened a full review
-- of, by the hand's key (`<match id>:<hand number>`, as the app names it), with when. A free
-- account reviews one new hand a UTC day; reopening a hand it reviewed before is free. Rows go
-- 30 days after the review, and with the account. A new table: a database that already holds
-- data takes it as is. Applied by src/migrate.ts inside one transaction. Never edit a migration
-- that has shipped.

CREATE TABLE hand_reviews (
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hand_key    text NOT NULL CHECK (length(hand_key) BETWEEN 1 AND 64),
  reviewed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, hand_key)
);
CREATE INDEX hand_reviews_user_at_idx ON hand_reviews (user_id, reviewed_at);
CREATE INDEX hand_reviews_at_idx ON hand_reviews (reviewed_at);
