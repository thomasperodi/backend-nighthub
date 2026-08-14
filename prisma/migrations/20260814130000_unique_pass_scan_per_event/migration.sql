-- Prevents two near-simultaneous scans of the same PR season pass at the same event from
-- both being recorded as accepted (the application-level pre-check in
-- checkInPrSeasonPassByQr ran before the insert, so it couldn't stop a true race - this
-- constraint is the actual enforcement, same pattern already used for table double-booking
-- and hostess table-number assignment elsewhere in this schema).
CREATE UNIQUE INDEX "pass_scans_unique_accepted_per_event_idx"
  ON "venue_pr_membership_pass_scans" ("pass_id", "event_id")
  WHERE "scan_result" = 'accepted' AND "event_id" IS NOT NULL;
