-- Structured contract fields for venue lifecycle management
ALTER TABLE "venues"
  ADD COLUMN "contract_start_at" TIMESTAMP(3),
  ADD COLUMN "contract_end_at" TIMESTAMP(3),
  ADD COLUMN "contract_status" TEXT,
  ADD COLUMN "contract_monthly_fee" DECIMAL(10,2),
  ADD COLUMN "contract_auto_renew" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "contract_notes" TEXT;

CREATE INDEX "venues_contract_end_at_idx"
ON "venues"("contract_end_at");

CREATE INDEX "venues_contract_status_idx"
ON "venues"("contract_status");
