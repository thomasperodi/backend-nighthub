ALTER TABLE "event_tables"
ADD COLUMN "confermato" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "event_tables_event_id_confermato_idx"
ON "event_tables"("event_id", "confermato");