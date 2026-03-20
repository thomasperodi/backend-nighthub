ALTER TABLE "users"
ADD COLUMN "location_sharing_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "last_latitude" DECIMAL(9,6),
ADD COLUMN "last_longitude" DECIMAL(9,6),
ADD COLUMN "last_location_accuracy_meters" INTEGER,
ADD COLUMN "last_location_updated_at" TIMESTAMP(3);

CREATE INDEX "users_location_sharing_enabled_last_location_updated_at_idx"
ON "users"("location_sharing_enabled", "last_location_updated_at");