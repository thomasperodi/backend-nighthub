import { computeEventStatus } from './event-time.util';

// Stored the way Prisma returns them: @db.Date at UTC midnight, @db.Time on 1970-01-01 UTC.
const day = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));
const time = (h: number, min = 0) => new Date(Date.UTC(1970, 0, 1, h, min));
// Europe/Rome is UTC+2 in summer: 30 Aug 2026 22:00 local = 20:00Z.
const at = (iso: string) => new Date(iso).getTime();

describe('computeEventStatus', () => {
  const night = {
    date: day(2026, 8, 30),
    start_time: time(22),
    end_time: time(4),
  };

  it('DRAFT before start, LIVE across midnight, CLOSED after end', () => {
    expect(
      computeEventStatus(
        { ...night, status: 'DRAFT' },
        at('2026-08-30T19:59:00Z'),
      ),
    ).toBe('DRAFT');
    expect(
      computeEventStatus(
        { ...night, status: 'DRAFT' },
        at('2026-08-30T20:00:00Z'),
      ),
    ).toBe('LIVE');
    expect(
      computeEventStatus(
        { ...night, status: 'DRAFT' },
        at('2026-08-31T01:59:00Z'),
      ),
    ).toBe('LIVE');
    expect(
      computeEventStatus(
        { ...night, status: 'LIVE' },
        at('2026-08-31T02:00:00Z'),
      ),
    ).toBe('CLOSED');
  });

  it('without end_time the night ends at 06:00 local the morning after', () => {
    const e = {
      date: day(2026, 8, 30),
      start_time: time(22),
      end_time: null,
      status: 'DRAFT' as const,
    };
    expect(computeEventStatus(e, at('2026-08-31T03:59:00Z'))).toBe('LIVE');
    expect(computeEventStatus(e, at('2026-08-31T04:00:00Z'))).toBe('CLOSED');
    // The bug this fixes: a month later it was still DRAFT ("in programma") and bookable.
    expect(computeEventStatus(e, at('2026-09-28T10:00:00Z'))).toBe('CLOSED');
  });

  it('without start_time it is DRAFT until the rollover, then CLOSED', () => {
    const e = {
      date: day(2026, 8, 30),
      start_time: null,
      end_time: null,
      status: 'DRAFT' as const,
    };
    expect(computeEventStatus(e, at('2026-08-30T12:00:00Z'))).toBe('DRAFT');
    expect(computeEventStatus(e, at('2026-08-31T04:00:00Z'))).toBe('CLOSED');
  });

  it('never recomputes a CANCELLED event', () => {
    for (const now of [
      '2026-08-30T10:00:00Z',
      '2026-08-30T21:00:00Z',
      '2026-09-28T10:00:00Z',
    ]) {
      expect(
        computeEventStatus({ ...night, status: 'CANCELLED' }, at(now)),
      ).toBe('CANCELLED');
    }
  });

  it('keeps the stored status when there is no date', () => {
    expect(computeEventStatus({ date: null, status: 'LIVE' })).toBe('LIVE');
  });

  it('handles the end of a month (rollover into the next month)', () => {
    const e = {
      date: day(2026, 10, 31),
      start_time: time(23),
      end_time: null,
      status: 'DRAFT' as const,
    };
    // 31 Oct 2026 is after the DST change: Rome is UTC+1, so 1 Nov 06:00 local = 05:00Z.
    expect(computeEventStatus(e, at('2026-11-01T04:59:00Z'))).toBe('LIVE');
    expect(computeEventStatus(e, at('2026-11-01T05:00:00Z'))).toBe('CLOSED');
  });
});
