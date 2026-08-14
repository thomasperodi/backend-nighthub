-- Physical tables ("venue_tables") are removed from the booking/staff pipeline. A table
-- reservation now targets a zone directly and IS the assignment - there is no longer an
-- intermediate "book a zone, venue assigns the physical table later" step
-- (superseding migration 20260727120000_reservations_by_table_zone's original model).
-- venue_tables itself is untouched (still used for floor-plan visual editing), but nothing
-- in the reservation/event_tables/sales pipeline references it anymore.

-- event_tables: rekey from venue_table_id to venue_table_zone_id.
ALTER TABLE "event_tables" DROP CONSTRAINT IF EXISTS "event_tables_venue_table_id_fkey";
DROP INDEX IF EXISTS "event_tables_event_id_venue_table_id_key";

ALTER TABLE "event_tables" ADD COLUMN IF NOT EXISTS "venue_table_zone_id" UUID;

-- No existing rows reference a table today (0 rows in event_tables at the time of this
-- migration), so there is nothing to backfill before enforcing NOT NULL.
ALTER TABLE "event_tables" ALTER COLUMN "venue_table_zone_id" SET NOT NULL;
ALTER TABLE "event_tables" DROP COLUMN IF EXISTS "venue_table_id";

CREATE UNIQUE INDEX IF NOT EXISTS "event_tables_event_id_venue_table_zone_id_key"
  ON "event_tables" ("event_id", "venue_table_zone_id");

DO $$ BEGIN
  ALTER TABLE "event_tables"
    ADD CONSTRAINT "event_tables_venue_table_zone_id_fkey"
    FOREIGN KEY ("venue_table_zone_id") REFERENCES "venue_table_zones"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- reservations: venue_table_id assignment is gone - venue_table_zone_id is the sole,
-- immediate assignment for a table reservation.
ALTER TABLE "reservations" DROP CONSTRAINT IF EXISTS "reservations_venue_table_id_fkey";
DROP INDEX IF EXISTS "reservations_venue_table_id_idx";
ALTER TABLE "reservations" DROP COLUMN IF EXISTS "venue_table_id";
