-- CreateEnum
CREATE TYPE "VenuePrMembershipPassStatus" AS ENUM ('active', 'revoked', 'expired');

-- CreateTable
CREATE TABLE "venue_pr_membership_passes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "pr_membership_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "VenuePrMembershipPassStatus" NOT NULL DEFAULT 'active',
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "valid_until" TIMESTAMP(3) NOT NULL,
    "qr_token" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "wallet_apple_url" TEXT,
    "wallet_google_url" TEXT,
    "wallet_last_issued_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_pr_membership_passes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_pr_membership_pass_scans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "pass_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "event_id" UUID,
    "pr_membership_id" UUID NOT NULL,
    "scanned_by_user_id" UUID,
    "entry_id" UUID,
    "scan_result" TEXT NOT NULL DEFAULT 'accepted',
    "reason" TEXT,
    "qr_payload" TEXT,
    "scanned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "venue_pr_membership_pass_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "venue_pr_membership_passes_pr_membership_id_key" ON "venue_pr_membership_passes"("pr_membership_id");

-- CreateIndex
CREATE UNIQUE INDEX "venue_pr_membership_passes_qr_token_key" ON "venue_pr_membership_passes"("qr_token");

-- CreateIndex
CREATE UNIQUE INDEX "venue_pr_membership_passes_serial_number_key" ON "venue_pr_membership_passes"("serial_number");

-- CreateIndex
CREATE INDEX "venue_pr_membership_passes_venue_id_status_idx" ON "venue_pr_membership_passes"("venue_id", "status");

-- CreateIndex
CREATE INDEX "venue_pr_membership_passes_user_id_status_idx" ON "venue_pr_membership_passes"("user_id", "status");

-- CreateIndex
CREATE INDEX "venue_pr_membership_passes_valid_until_idx" ON "venue_pr_membership_passes"("valid_until");

-- CreateIndex
CREATE INDEX "venue_pr_membership_pass_scans_pass_id_scanned_at_idx" ON "venue_pr_membership_pass_scans"("pass_id", "scanned_at");

-- CreateIndex
CREATE INDEX "venue_pr_membership_pass_scans_venue_id_event_id_scanned_at_idx" ON "venue_pr_membership_pass_scans"("venue_id", "event_id", "scanned_at");

-- CreateIndex
CREATE INDEX "venue_pr_membership_pass_scans_pr_membership_id_scanned_at_idx" ON "venue_pr_membership_pass_scans"("pr_membership_id", "scanned_at");

-- CreateIndex
CREATE INDEX "venue_pr_membership_pass_scans_scan_result_scanned_at_idx" ON "venue_pr_membership_pass_scans"("scan_result", "scanned_at");

-- AddForeignKey
ALTER TABLE "venue_pr_membership_passes"
ADD CONSTRAINT "venue_pr_membership_passes_venue_id_fkey"
FOREIGN KEY ("venue_id") REFERENCES "venues"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_membership_passes"
ADD CONSTRAINT "venue_pr_membership_passes_pr_membership_id_fkey"
FOREIGN KEY ("pr_membership_id") REFERENCES "venue_pr_memberships"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_membership_passes"
ADD CONSTRAINT "venue_pr_membership_passes_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_membership_pass_scans"
ADD CONSTRAINT "venue_pr_membership_pass_scans_pass_id_fkey"
FOREIGN KEY ("pass_id") REFERENCES "venue_pr_membership_passes"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_membership_pass_scans"
ADD CONSTRAINT "venue_pr_membership_pass_scans_venue_id_fkey"
FOREIGN KEY ("venue_id") REFERENCES "venues"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_membership_pass_scans"
ADD CONSTRAINT "venue_pr_membership_pass_scans_event_id_fkey"
FOREIGN KEY ("event_id") REFERENCES "events"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_membership_pass_scans"
ADD CONSTRAINT "venue_pr_membership_pass_scans_pr_membership_id_fkey"
FOREIGN KEY ("pr_membership_id") REFERENCES "venue_pr_memberships"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_membership_pass_scans"
ADD CONSTRAINT "venue_pr_membership_pass_scans_scanned_by_user_id_fkey"
FOREIGN KEY ("scanned_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
