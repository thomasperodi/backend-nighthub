-- Table reservations target a zone first. The venue assigns the table later.
ALTER TABLE "reservations"
  ADD COLUMN IF NOT EXISTS "venue_table_zone_id" UUID;

ALTER TABLE "reservations"
  ADD CONSTRAINT "reservations_venue_table_zone_id_fkey"
  FOREIGN KEY ("venue_table_zone_id") REFERENCES "venue_table_zones"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "reservations_venue_table_zone_id_idx"
  ON "reservations" ("venue_table_zone_id");