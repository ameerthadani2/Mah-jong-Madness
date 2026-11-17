-- 0015_rush_answers: a ranked Puzzle Rush run is played one puzzle at a time. The server serves a
-- puzzle only once the previous answer has arrived, judges and stamps each answer as it comes, and
-- times the run from those stamps; a run whose answer times no person makes is recorded as inhuman
-- (off the Rush board, counted toward the automation flag). docs/API.md, "Puzzle Rush" and
-- "Plausible answer times". Applied by src/migrate.ts inside one transaction. Never edit a
-- migration that has shipped.

ALTER TABLE puzzle_rush_runs ADD COLUMN served_index integer NOT NULL DEFAULT 0 CHECK (served_index >= 0);
ALTER TABLE puzzle_rush_runs ADD COLUMN served_at timestamptz;
UPDATE puzzle_rush_runs SET served_at = started_at;
ALTER TABLE puzzle_rush_runs ALTER COLUMN served_at SET NOT NULL;
ALTER TABLE puzzle_rush_runs ADD COLUMN inhuman boolean NOT NULL DEFAULT false;

CREATE TABLE puzzle_rush_answers (
  run_id      uuid NOT NULL REFERENCES puzzle_rush_runs (id) ON DELETE CASCADE,
  idx         integer NOT NULL CHECK (idx >= 0),
  type        text NOT NULL CHECK (type IN ('discard', 'waits', 'defence', 'claim', 'value')),
  correct     boolean NOT NULL,
  served_at   timestamptz NOT NULL,
  answered_at timestamptz NOT NULL,
  PRIMARY KEY (run_id, idx)
);
