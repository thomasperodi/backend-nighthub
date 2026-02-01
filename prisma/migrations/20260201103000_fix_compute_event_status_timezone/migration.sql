-- Fix compute_event_status timezone assumptions.
-- Events are stored as date + time (local venue wall-clock time).
-- Compare using Europe/Rome so LIVE/CLOSED transitions match real local time.

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
          WHEN (now() AT TIME ZONE 'Europe/Rome') < (event_date + start_time) THEN 'DRAFT'::"EventStatus"
          WHEN (now() AT TIME ZONE 'Europe/Rome') < (
            event_date + end_time +
            CASE WHEN end_time <= start_time THEN interval '1 day' ELSE interval '0 day' END
          ) THEN 'LIVE'::"EventStatus"
          ELSE 'CLOSED'::"EventStatus"
        END
    END;
$$;
