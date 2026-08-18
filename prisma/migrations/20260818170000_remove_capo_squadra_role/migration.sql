-- Confirmed business decision (2026-08-18): PR hierarchy simplifies from 3 tiers
-- (responsabile > capo_squadra > pr) to 2 (responsabile > pr). Existing capo_squadra
-- memberships are promoted to responsabile. parent_membership_id is cleared on the
-- promoted rows too, since a responsabile must never have a parent under the new 2-tier
-- rule (it previously pointed at another responsabile, which was valid for capo_squadra
-- but would violate validatePrHierarchy's "RESPONSABILE cannot have a superior" check).
UPDATE "venue_pr_memberships"
SET "role" = 'responsabile', "parent_membership_id" = NULL
WHERE "role" = 'capo_squadra';

-- Postgres has no `ALTER TYPE ... DROP VALUE` - recreate the enum without it instead.
CREATE TYPE "VenuePrRole_new" AS ENUM ('responsabile', 'pr');

ALTER TABLE "venue_pr_memberships"
  ALTER COLUMN "role" TYPE "VenuePrRole_new"
  USING ("role"::text::"VenuePrRole_new");

DROP TYPE "VenuePrRole";
ALTER TYPE "VenuePrRole_new" RENAME TO "VenuePrRole";
