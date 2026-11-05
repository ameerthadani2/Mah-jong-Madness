-- 0002_store_reports_seasons: store notifications, player reports and club seasons.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- Every store notification (RevenueCat webhook event) as it arrived. The event id is the
-- idempotency key: a redelivered event finds its row and changes nothing. Like purchases, no
-- foreign key to users, so the record outlives an account's hard deletion.
CREATE TABLE store_events (
  event_id    text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 255),
  vendor      text NOT NULL,
  type        text NOT NULL,
  user_id     uuid,
  product_id  text,
  environment text,
  outcome     text NOT NULL DEFAULT 'received',
  raw         jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_events_user_idx ON store_events (user_id, received_at) WHERE user_id IS NOT NULL;

-- "Report player". Kept when either account is deleted: moderation records, not profile data.
CREATE TABLE reports (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reporter_id      uuid NOT NULL,
  reported_user_id uuid NOT NULL,
  room_code        text CHECK (room_code IS NULL OR room_code ~ '^[A-Z0-9]{4,8}$'),
  reason           text NOT NULL CHECK (reason IN ('cheating', 'collusion', 'abusive_chat', 'offensive_name', 'stalling', 'other')),
  details          text CHECK (details IS NULL OR length(details) <= 1000),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (reporter_id <> reported_user_id)
);
CREATE INDEX reports_reporter_idx ON reports (reporter_id, created_at);
CREATE INDEX reports_reported_idx ON reports (reported_user_id, created_at);
CREATE INDEX reports_open_idx ON reports (created_at) WHERE status = 'open';

-- Club seasons: clubs.season already exists (0001). season_history holds the archived standings
-- of finished seasons, oldest first: [{ season, startedAt, endedAt, standings: [{ userId, name, points }] }].
ALTER TABLE clubs ADD COLUMN season_started_at timestamptz;
ALTER TABLE clubs ADD COLUMN season_history jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE clubs SET season_started_at = created_at WHERE season_started_at IS NULL;

-- No season has ever been reset before this migration, so the current season holds every point.
UPDATE club_members SET season_points = lifetime_points;
