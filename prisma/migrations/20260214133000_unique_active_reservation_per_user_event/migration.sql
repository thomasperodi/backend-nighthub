-- Prevent duplicate active reservations for the same user and event.
-- Cancelled reservations are excluded so user can rebook after cancellation.
WITH ranked_active AS (
	SELECT
		id,
		ROW_NUMBER() OVER (
			PARTITION BY user_id, event_id
			ORDER BY created_at DESC, id DESC
		) AS row_num
	FROM reservations
	WHERE status <> 'cancelled'
)
UPDATE reservations r
SET status = 'cancelled'::"ReservationStatus"
FROM ranked_active ra
WHERE r.id = ra.id
	AND ra.row_num > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "reservations_unique_active_user_event_idx"
ON "reservations" ("user_id", "event_id")
WHERE "status" <> 'cancelled';
