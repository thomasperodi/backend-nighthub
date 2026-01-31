-- Add indexes to speed up reservations + promos listing patterns

-- Promos by venue ordered by created_at
CREATE INDEX IF NOT EXISTS "promos_venue_id_created_at_idx" ON "promos"("venue_id", "created_at");

-- Reservations lists ordered by created_at with filters
CREATE INDEX IF NOT EXISTS "reservations_event_id_created_at_idx" ON "reservations"("event_id", "created_at");
CREATE INDEX IF NOT EXISTS "reservations_user_id_created_at_idx" ON "reservations"("user_id", "created_at");
