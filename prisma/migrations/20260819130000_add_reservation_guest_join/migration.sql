-- Referral guest-join: lets an unauthenticated visitor from a PR referral link ("Mettiti in
-- lista") create an "entry" reservation without logging in. user_id becomes optional -
-- either the reservation belongs to a real account (user_id set, guest_* null) or it's a
-- standalone guest attendance (user_id null, guest_name/guest_surname/guest_email set).

ALTER TABLE "reservations" ALTER COLUMN "user_id" DROP NOT NULL;

ALTER TABLE "reservations"
  ADD COLUMN "guest_name" TEXT,
  ADD COLUMN "guest_surname" TEXT,
  ADD COLUMN "guest_email" TEXT,
  ADD COLUMN "guest_token" TEXT;

CREATE UNIQUE INDEX "reservations_guest_token_key" ON "reservations" ("guest_token");

CREATE INDEX "reservations_event_id_guest_email_idx" ON "reservations" ("event_id", "guest_email");

-- Dedup for guest (user_id IS NULL) entries: one active "entry" reservation per event per
-- guest email. The existing reservations_unique_active_user_event_type_idx only dedupes
-- authenticated reservations - Postgres treats every NULL user_id as distinct, so it never
-- caught two guest rows for the same event/email without this.
CREATE UNIQUE INDEX "reservations_unique_active_guest_event_idx"
ON "reservations" ("event_id", "guest_email")
WHERE "status" <> 'cancelled' AND "user_id" IS NULL AND "guest_email" IS NOT NULL AND "type" = 'entry';
