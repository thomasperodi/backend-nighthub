-- One PR season pass per (venue, membership) instead of one per membership.
-- An organization PR (venue_id NULL on the membership) works every venue linked to the
-- organization; with the old unique on pr_membership_id, opening the pass at a second venue
-- failed with a unique violation (500). Each venue keeps its own branded pass
-- (venue_wallet_templates). qr_token stays globally unique.
DROP INDEX IF EXISTS "venue_pr_membership_passes_pr_membership_id_key";

CREATE UNIQUE INDEX "venue_pr_membership_passes_venue_id_pr_membership_id_key"
  ON "venue_pr_membership_passes"("venue_id", "pr_membership_id");

CREATE INDEX IF NOT EXISTS "venue_pr_membership_passes_pr_membership_id_idx"
  ON "venue_pr_membership_passes"("pr_membership_id");
