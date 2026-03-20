ALTER TABLE "events"
ADD COLUMN "is_featured" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "events_is_featured_date_idx" ON "events"("is_featured", "date");