-- Add indexes to speed up /events listing and promos include

-- Events: common filters/orderings
CREATE INDEX IF NOT EXISTS "events_venue_id_date_idx" ON "events"("venue_id", "date");
CREATE INDEX IF NOT EXISTS "events_date_start_time_idx" ON "events"("date", "start_time");
CREATE INDEX IF NOT EXISTS "events_status_idx" ON "events"("status");

-- Promos: included per event with status filter and created_at ordering
CREATE INDEX IF NOT EXISTS "promos_event_id_status_created_at_idx" ON "promos"("event_id", "status", "created_at");
