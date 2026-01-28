-- CreateTable
CREATE TABLE "event_entry_prices" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "label" TEXT,
    "gender" "Gender",
    "start_time" TIME(6),
    "end_time" TIME(6),
    "price" DECIMAL(65,30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_entry_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "event_entry_prices_event_id_idx" ON "event_entry_prices"("event_id");

-- AddForeignKey
ALTER TABLE "event_entry_prices" ADD CONSTRAINT "event_entry_prices_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
