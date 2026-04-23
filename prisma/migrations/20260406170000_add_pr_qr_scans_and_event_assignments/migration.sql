-- AlterTable
ALTER TABLE "entries"
ADD COLUMN "pr_membership_id" UUID;

-- CreateTable
CREATE TABLE "venue_pr_event_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "pr_membership_id" UUID NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "assigned_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_pr_event_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_pr_qr_scans" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "pr_membership_id" UUID NOT NULL,
    "scanned_by_user_id" UUID,
    "guest_user_id" UUID,
    "referral_code" TEXT NOT NULL,
    "scanned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entry_id" UUID,
    "entered_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_pr_qr_scans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entries_pr_membership_id_created_at_idx" ON "entries"("pr_membership_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "venue_pr_event_assignments_event_id_pr_membership_id_key" ON "venue_pr_event_assignments"("event_id", "pr_membership_id");

-- CreateIndex
CREATE INDEX "venue_pr_event_assignments_venue_id_event_id_is_active_idx" ON "venue_pr_event_assignments"("venue_id", "event_id", "is_active");

-- CreateIndex
CREATE INDEX "venue_pr_event_assignments_pr_membership_id_is_active_idx" ON "venue_pr_event_assignments"("pr_membership_id", "is_active");

-- CreateIndex
CREATE INDEX "venue_pr_qr_scans_venue_id_event_id_scanned_at_idx" ON "venue_pr_qr_scans"("venue_id", "event_id", "scanned_at");

-- CreateIndex
CREATE INDEX "venue_pr_qr_scans_pr_membership_id_scanned_at_idx" ON "venue_pr_qr_scans"("pr_membership_id", "scanned_at");

-- CreateIndex
CREATE INDEX "venue_pr_qr_scans_entry_id_idx" ON "venue_pr_qr_scans"("entry_id");

-- CreateIndex
CREATE INDEX "venue_pr_qr_scans_guest_user_id_scanned_at_idx" ON "venue_pr_qr_scans"("guest_user_id", "scanned_at");

-- AddForeignKey
ALTER TABLE "entries"
ADD CONSTRAINT "entries_pr_membership_id_fkey"
FOREIGN KEY ("pr_membership_id") REFERENCES "venue_pr_memberships"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_event_assignments"
ADD CONSTRAINT "venue_pr_event_assignments_venue_id_fkey"
FOREIGN KEY ("venue_id") REFERENCES "venues"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_event_assignments"
ADD CONSTRAINT "venue_pr_event_assignments_event_id_fkey"
FOREIGN KEY ("event_id") REFERENCES "events"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_event_assignments"
ADD CONSTRAINT "venue_pr_event_assignments_pr_membership_id_fkey"
FOREIGN KEY ("pr_membership_id") REFERENCES "venue_pr_memberships"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_qr_scans"
ADD CONSTRAINT "venue_pr_qr_scans_venue_id_fkey"
FOREIGN KEY ("venue_id") REFERENCES "venues"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_qr_scans"
ADD CONSTRAINT "venue_pr_qr_scans_event_id_fkey"
FOREIGN KEY ("event_id") REFERENCES "events"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_qr_scans"
ADD CONSTRAINT "venue_pr_qr_scans_pr_membership_id_fkey"
FOREIGN KEY ("pr_membership_id") REFERENCES "venue_pr_memberships"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
