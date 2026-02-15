-- Prevent duplicate active reservations for the same user and event.
-- Cancelled reservations are excluded so user can rebook after cancellation.
CREATE UNIQUE INDEX IF NOT EXISTS "reservations_unique_active_user_event_idx"
ON "reservations" ("user_id", "event_id")
WHERE "status" <> 'cancelled';
