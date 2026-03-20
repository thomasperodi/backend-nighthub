ALTER TABLE "users"
ADD COLUMN "last_active_at" TIMESTAMP(3);

CREATE INDEX "users_last_active_at_idx"
ON "users"("last_active_at");