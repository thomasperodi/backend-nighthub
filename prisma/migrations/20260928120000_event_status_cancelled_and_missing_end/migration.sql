-- compute_event_status: same rules as computeEventStatus() in src/common/event-time.util.ts.
-- 1. CANCELLED is a manual decision and is never recomputed. Before this, a cancelled event
--    with date/start/end came back as DRAFT/LIVE/CLOSED, and the status sync wrote that back.
-- 2. A missing end_time no longer freezes the event on its stored status forever: the night
--    ends at 06:00 the morning after its date (same rollover as the PR network).
-- 3. A missing start_time: DRAFT until that rollover, then CLOSED.

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
      WHEN stored_status = 'CANCELLED'::"EventStatus" OR event_date IS NULL THEN stored_status
      WHEN start_time IS NULL THEN
        CASE
          WHEN (now() AT TIME ZONE 'Europe/Rome') >= ((event_date + 1) + time '06:00') THEN 'CLOSED'::"EventStatus"
          ELSE 'DRAFT'::"EventStatus"
        END
      ELSE
        CASE
          WHEN (now() AT TIME ZONE 'Europe/Rome') < (event_date + start_time) THEN 'DRAFT'::"EventStatus"
          WHEN (now() AT TIME ZONE 'Europe/Rome') < (
            CASE
              WHEN end_time IS NULL THEN (event_date + 1) + time '06:00'
              ELSE event_date + end_time +
                CASE WHEN end_time <= start_time THEN interval '1 day' ELSE interval '0 day' END
            END
          ) THEN 'LIVE'::"EventStatus"
          ELSE 'CLOSED'::"EventStatus"
        END
    END;
$$;
