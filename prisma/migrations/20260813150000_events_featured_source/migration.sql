-- CreateEnum
CREATE TYPE "EventFeaturedSource" AS ENUM ('manual', 'auto');

-- AlterTable
ALTER TABLE "events" DROP COLUMN "is_trending";
ALTER TABLE "events" ADD COLUMN "featured_source" "EventFeaturedSource";

-- Existing is_featured=true rows predate the manual/auto distinction - treat them as
-- manual grants so the new auto-cron doesn't touch (and potentially turn off) something
-- that was already deliberately set before this migration.
UPDATE "events" SET "featured_source" = 'manual' WHERE "is_featured" = true;
