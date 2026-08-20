-- Org-invited PRs now work every venue their organization is linked to (organization_venue_links),
-- instead of being scoped to a single venue chosen at invite time. venue_id on
-- venue_pr_memberships becomes nullable: still required in application logic for venue-only
-- rows (organization_id NULL), always NULL for org-owned rows (organization_id set) - one row
-- per (organization_id, user_id) instead of one row per (venue_id, user_id) per organization.

-- Must happen before nulling out venue_id below, or the still-NOT-NULL column rejects it.
ALTER TABLE "venue_pr_memberships" ALTER COLUMN "venue_id" DROP NOT NULL;

-- Dedup existing org-owned rows down to one per (organization_id, user_id), keeping the
-- oldest membership. Re-parents any child hierarchy rows and reassigns dependent rows
-- (event assignments, qr scans, tracked entries, season pass) from the rows being dropped
-- onto the row being kept, so no PR history is lost.
DO $$
DECLARE
  keep RECORD;
  dupe RECORD;
BEGIN
  FOR keep IN
    SELECT DISTINCT ON (organization_id, user_id) id, organization_id, user_id
    FROM venue_pr_memberships
    WHERE organization_id IS NOT NULL
    ORDER BY organization_id, user_id, created_at ASC
  LOOP
    FOR dupe IN
      SELECT id FROM venue_pr_memberships
      WHERE organization_id = keep.organization_id
        AND user_id = keep.user_id
        AND id <> keep.id
    LOOP
      UPDATE venue_pr_event_assignments SET pr_membership_id = keep.id WHERE pr_membership_id = dupe.id;
      UPDATE venue_pr_qr_scans SET pr_membership_id = keep.id WHERE pr_membership_id = dupe.id;
      UPDATE entries SET pr_membership_id = keep.id WHERE pr_membership_id = dupe.id;
      UPDATE venue_pr_membership_passes SET pr_membership_id = keep.id WHERE pr_membership_id = dupe.id;
      UPDATE venue_pr_membership_pass_scans SET pr_membership_id = keep.id WHERE pr_membership_id = dupe.id;
      UPDATE venue_pr_memberships SET parent_membership_id = keep.id WHERE parent_membership_id = dupe.id;
      DELETE FROM venue_pr_memberships WHERE id = dupe.id;
    END LOOP;
  END LOOP;
END $$;

-- Org-owned rows no longer carry a venue_id.
UPDATE venue_pr_memberships SET venue_id = NULL WHERE organization_id IS NOT NULL;

-- ref_code was venue-scoped unique; now global so a scan lookup doesn't need to know the
-- row's kind up front. ref_code generation already appends a random suffix, so collisions
-- across the (small) existing dataset are not expected, but resolve them defensively first.
DO $$
DECLARE
  dupe RECORD;
  suffix TEXT;
BEGIN
  FOR dupe IN
    SELECT id, ref_code FROM venue_pr_memberships m
    WHERE EXISTS (
      SELECT 1 FROM venue_pr_memberships m2
      WHERE upper(m2.ref_code) = upper(m.ref_code) AND m2.id < m.id
    )
  LOOP
    suffix := substr(md5(random()::text), 1, 4);
    UPDATE venue_pr_memberships SET ref_code = dupe.ref_code || suffix WHERE id = dupe.id;
  END LOOP;
END $$;

DROP INDEX "venue_pr_memberships_venue_id_ref_code_key";
CREATE UNIQUE INDEX "venue_pr_memberships_ref_code_key" ON "venue_pr_memberships"("ref_code");
CREATE UNIQUE INDEX "venue_pr_memberships_organization_id_user_id_key" ON "venue_pr_memberships"("organization_id", "user_id");
