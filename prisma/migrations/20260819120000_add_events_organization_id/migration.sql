-- AlterTable: events.organization_id (nullable - most events are still venue-created)
ALTER TABLE "events" ADD COLUMN "organization_id" UUID;

-- CreateIndex
CREATE INDEX "events_organization_id_idx" ON "events"("organization_id");

-- AddForeignKey
ALTER TABLE "events"
ADD CONSTRAINT "events_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
