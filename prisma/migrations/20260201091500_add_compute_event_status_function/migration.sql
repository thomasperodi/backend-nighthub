-- Compute EventStatus (DRAFT/LIVE/CLOSED) from date + time window.
-- Handles events that end after midnight (e.g. 23:00 -> 05:00 next day).
-- Uses UTC "now" to match existing @db.Time UTC-component convention.

CREATE OR REPLACE FUNCTION public.compute_event_status(
  event_date date,
  start_time time,
  end_time time,
  stored_status "EventStatus"
) RETURNS "EventStatus"
LANGUAGE sql
STABLE
AS $$
  SELECT
    CASE
      WHEN event_date IS NULL OR start_time IS NULL OR end_time IS NULL THEN stored_status
      ELSE
        CASE
          WHEN (now() AT TIME ZONE 'UTC') < (event_date + start_time) THEN 'DRAFT'::"EventStatus"
          WHEN (now() AT TIME ZONE 'UTC') < (
            event_date + end_time +
            CASE WHEN end_time <= start_time THEN interval '1 day' ELSE interval '0 day' END
          ) THEN 'LIVE'::"EventStatus"
          ELSE 'CLOSED'::"EventStatus"
        END
    END;
$$;
