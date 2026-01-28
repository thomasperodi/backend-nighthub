/*
  Warnings:

  - A unique constraint covering the columns `[event_id,venue_table_id]` on the table `event_tables` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "event_tables_event_id_venue_table_id_key" ON "event_tables"("event_id", "venue_table_id");
