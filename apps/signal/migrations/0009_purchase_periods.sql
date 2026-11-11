-- 0009_purchase_periods: when the period a subscription transaction paid for ends.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- A refund names one store transaction. To take back only that transaction's time (and not a
-- later period the player has paid for, or the rest of an earlier one still running), the server
-- needs to know how far each paid transaction of a plan reaches. Written for the first purchase
-- and every renewal of a subscription; NULL for diamond packs and for rows older than this
-- column, which a refund then treats as before.
ALTER TABLE purchases ADD COLUMN period_ends_at timestamptz;
