ALTER TABLE "venues" ALTER COLUMN "radius_geofence" SET DEFAULT 100;
UPDATE "venues" SET "radius_geofence" = 100 WHERE "radius_geofence" IS NULL;
ALTER TABLE "venues" ALTER COLUMN "radius_geofence" SET NOT NULL;
