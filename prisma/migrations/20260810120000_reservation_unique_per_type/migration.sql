-- Allow a user to hold one active "entry" reservation AND one active "table"
-- reservation for the same event at the same time. Previously the unique
-- index was on (user_id, event_id) only, which blocked booking a table
-- while already on the entry list (and vice versa).
DROP INDEX IF EXISTS "reservations_unique_active_user_event_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "reservations_unique_active_user_event_type_idx"
ON "reservations" ("user_id", "event_id", "type")
WHERE "status" <> 'cancelled';
