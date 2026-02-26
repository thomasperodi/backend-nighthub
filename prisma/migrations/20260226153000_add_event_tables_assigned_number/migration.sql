ALTER TABLE "event_tables"
ADD COLUMN "assigned_number" INTEGER;

CREATE INDEX "event_tables_event_id_assigned_number_idx"
ON "event_tables"("event_id", "assigned_number");

CREATE UNIQUE INDEX "event_tables_event_id_assigned_number_unique"
ON "event_tables"("event_id", "assigned_number")
WHERE "assigned_number" IS NOT NULL;
