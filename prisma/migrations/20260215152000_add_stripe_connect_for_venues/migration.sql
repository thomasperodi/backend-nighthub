-- Stripe Connect support for direct-to-venue ticket payments
ALTER TABLE "venues"
  ADD COLUMN "stripe_account_id" TEXT,
  ADD COLUMN "stripe_charges_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stripe_payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "stripe_onboarding_completed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "venues_stripe_account_id_key"
ON "venues"("stripe_account_id");

ALTER TABLE "ticket_orders"
  ADD COLUMN "stripe_account_id" TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX "ticket_orders_stripe_account_id_created_at_idx"
ON "ticket_orders"("stripe_account_id", "created_at");

-- Clear default once backfilled by app logic
ALTER TABLE "ticket_orders"
  ALTER COLUMN "stripe_account_id" DROP DEFAULT;
