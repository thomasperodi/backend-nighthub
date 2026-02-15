-- Add QR + check-in tracking fields for entry reservations
ALTER TABLE "reservations"
ADD COLUMN IF NOT EXISTS "qr_token" TEXT,
ADD COLUMN IF NOT EXISTS "qr_payload" TEXT,
ADD COLUMN IF NOT EXISTS "checked_in_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "checked_in_by_staff_id" UUID,
ADD COLUMN IF NOT EXISTS "checkin_entry_id" UUID;

CREATE UNIQUE INDEX IF NOT EXISTS "reservations_qr_token_key"
ON "reservations"("qr_token");

CREATE INDEX IF NOT EXISTS "reservations_event_id_type_status_idx"
ON "reservations"("event_id", "type", "status");

CREATE INDEX IF NOT EXISTS "reservations_checked_in_by_staff_id_idx"
ON "reservations"("checked_in_by_staff_id");
