-- 0003_server_hardening: the account that opened each hosted table.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- The server caps how many unfinished tables one account may have open (MAX_TABLES_PER_USER). The
-- creator is written inside the snapshot (`createdBy`) so a restored table still counts; this
-- generated column exposes it for queries and support without a second place to keep in step.
ALTER TABLE table_snapshots
  ADD COLUMN created_by text GENERATED ALWAYS AS (snapshot ->> 'createdBy') STORED;
CREATE INDEX table_snapshots_created_by_idx ON table_snapshots (created_by) WHERE status <> 'finished';
