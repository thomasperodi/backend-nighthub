-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "venue_table_id" UUID;

-- CreateIndex
CREATE INDEX "reservations_venue_table_id_idx" ON "reservations"("venue_table_id");

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_venue_table_id_fkey" FOREIGN KEY ("venue_table_id") REFERENCES "venue_tables"("id") ON DELETE SET NULL ON UPDATE CASCADE;
