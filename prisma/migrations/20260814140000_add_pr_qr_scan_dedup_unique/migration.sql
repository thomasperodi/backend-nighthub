-- Prevents the same PR from registering more than one scan for the same guest at the same
-- event (anti-spam on venue_pr_qr_scans / PR conversion stats). Rows with guest_user_id NULL
-- are unaffected - Postgres treats NULL as distinct in a unique constraint.
ALTER TABLE "venue_pr_qr_scans"
  ADD CONSTRAINT "uniq_pr_qr_scan_per_guest" UNIQUE ("event_id", "pr_membership_id", "guest_user_id");
