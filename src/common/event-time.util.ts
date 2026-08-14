// Shared helpers for converting an event's local wall-clock date/time (@db.Date + @db.Time,
// intended as venue-local time) into an absolute instant. Extracted from EventsService so
// other services (e.g. reminder notifications) can compute the same "when does this event
// actually start" without duplicating the DST-aware timezone math.

export function getEventsTimeZone(): string {
  // Events times (date + @db.Time) are intended as local venue time. Defaulting to
  // Europe/Rome keeps behavior aligned with production expectations.
  return process.env.EVENTS_TIMEZONE || 'Europe/Rome';
}

function getTimeZoneOffsetMs(timeZone: string, instant: Date): number {
  // Returns offset where: localTime = utcTime + offset
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts = dtf.formatToParts(instant);
  const map = new Map(parts.map((p) => [p.type, p.value]));
  const year = Number(map.get('year'));
  const month = Number(map.get('month'));
  const day = Number(map.get('day'));
  const hour = Number(map.get('hour'));
  const minute = Number(map.get('minute'));
  const second = Number(map.get('second'));

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - instant.getTime();
}

export function zonedDateTimeToUtcMs(params: {
  timeZone: string;
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second?: number;
}): number {
  const baseUtc = Date.UTC(
    params.year,
    params.month - 1,
    params.day,
    params.hour,
    params.minute,
    params.second ?? 0,
    0,
  );

  // Two-pass conversion to handle DST boundaries correctly.
  const guess = new Date(baseUtc);
  const offset1 = getTimeZoneOffsetMs(params.timeZone, guess);
  const utc1 = baseUtc - offset1;
  const offset2 = getTimeZoneOffsetMs(params.timeZone, new Date(utc1));
  return baseUtc - offset2;
}

/** The absolute instant (epoch ms) an event actually starts, or null if it doesn't have
 * enough data (date + start_time) to compute one. */
export function eventStartMs(e: {
  date?: Date | null;
  start_time?: Date | null;
}): number | null {
  if (!e?.date || !e?.start_time) return null;

  const timeZone = getEventsTimeZone();

  // Date is @db.Date: use UTC date parts to avoid timezone drift for the calendar day.
  // start_time is @db.Time: use UTC time parts to extract the raw time value.
  const year = e.date.getUTCFullYear();
  const month = e.date.getUTCMonth() + 1;
  const day = e.date.getUTCDate();
  const hour = e.start_time.getUTCHours();
  const minute = e.start_time.getUTCMinutes();

  return zonedDateTimeToUtcMs({ timeZone, year, month, day, hour, minute });
}
