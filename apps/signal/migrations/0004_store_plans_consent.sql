-- 0004_store_plans_consent: one entitlement per subscription plan, refunds that may leave a
-- negative balance, and the player's analytics choice.
-- Applied by src/migrate.ts inside one transaction. Never edit a migration that has shipped.

-- Each subscription plan is now its own entitlement (coach.gold.month, coach.gold.year,
-- fourwinds.month, fourwinds.year), so refunding one plan never ends another. Rows written under
-- the old shared names carry on as the monthly plan of the same tier, with the same expiry.
-- Coach Platinum became The Four Winds Club.
UPDATE entitlements SET entitlement = 'coach.gold.month' WHERE entitlement = 'coach.gold';
UPDATE entitlements SET entitlement = 'fourwinds.month' WHERE entitlement = 'coach.platinum';

-- A refunded diamond pack takes back everything it credited, even when some was already spent:
-- the purchased balance may go below zero, and no spend goes through until it is back above.
-- Bonus diamonds still never go below zero.
ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_diamonds_check;

-- Server-side product analytics only for players who said yes in the app (PATCH /api/me
-- analyticsConsent). Null means the app has not said, which counts as no.
ALTER TABLE users ADD COLUMN analytics_consent boolean;
