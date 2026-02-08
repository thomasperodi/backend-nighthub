-- CreateTable
CREATE TABLE "venue_stays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "entered_at" TIMESTAMP(3) NOT NULL,
    "exited_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_stays_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "venue_stays_user_id_entered_at_idx" ON "venue_stays"("user_id", "entered_at");

-- CreateIndex
CREATE INDEX "venue_stays_venue_id_entered_at_idx" ON "venue_stays"("venue_id", "entered_at");

-- CreateIndex
CREATE INDEX "venue_stays_venue_id_exited_at_idx" ON "venue_stays"("venue_id", "exited_at");

-- AddForeignKey
ALTER TABLE "venue_stays" ADD CONSTRAINT "venue_stays_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_stays" ADD CONSTRAINT "venue_stays_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
