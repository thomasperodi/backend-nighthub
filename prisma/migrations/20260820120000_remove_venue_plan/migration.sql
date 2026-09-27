-- Removes the legacy "plan assigned to a venue" concept. Billing now lives exclusively on
-- organizations (organizations.plan_id, see 20260818153000_add_organization_plan) - the
-- venue-side plan/overage metering ("clienti analizzati") was never fully migrated and is now
-- dropped outright, per confirmed business decision 2026-08-20. The shared `subscription_plans`
-- catalog table itself is NOT dropped: organizations still reference it.

ALTER TABLE "venues" DROP CONSTRAINT IF EXISTS "venues_plan_id_fkey";
DROP INDEX IF EXISTS "venues_plan_id_idx";
ALTER TABLE "venues" DROP COLUMN IF EXISTS "plan_id";
ALTER TABLE "venues" DROP COLUMN IF EXISTS "plan_custom_terms";
