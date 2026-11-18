-- 0021_damaged_snapshots: a table snapshot that cannot be restored as a live table (malformed, or a
-- game or rules the engine does not accept: src/restoreCheck.ts) is kept as 'damaged' for an admin
-- (GET /api/admin/tables/damaged), with the reason in `problem`, instead of being marked finished.
-- It is never restored again, and it is dropped 30 days after it was found.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.
ALTER TABLE table_snapshots DROP CONSTRAINT table_snapshots_status_check;
ALTER TABLE table_snapshots ADD CONSTRAINT table_snapshots_status_check CHECK (status IN ('open', 'playing', 'finished', 'damaged'));
ALTER TABLE table_snapshots ADD COLUMN problem text CHECK (problem IS NULL OR length(problem) <= 500);
