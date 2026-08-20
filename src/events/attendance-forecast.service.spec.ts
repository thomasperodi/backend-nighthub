import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AttendanceForecastService } from './attendance-forecast.service';
import { PrismaService } from '../prisma/prisma.service';

function makePrismaMock() {
  return {
    events: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    reservations: {
      findMany: jest.fn(),
    },
    entries: {
      groupBy: jest.fn(),
    },
    event_forecasts: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
  };
}

// One reservation row per person for simplicity - `guests: 1` everywhere - so the numbers in
// each test are easy to eyeball.
function historicalRow(overrides: {
  event_id: string;
  status?: 'confirmed' | 'completed' | 'cancelled';
  guests?: number;
  actual_guests?: number | null;
  checkin_entry_id?: string | null;
}) {
  return {
    event_id: overrides.event_id,
    status: overrides.status ?? 'confirmed',
    guests: overrides.guests ?? 1,
    actual_guests: overrides.actual_guests ?? null,
    checkin_entry_id: overrides.checkin_entry_id ?? null,
  };
}

/**
 * `reservations.findMany` is called from three different places in the service (today's
 * list, the historical cascade sample, and per-user personal rates) - this routes each call
 * to the right fixture by inspecting its `where` shape, the same way Prisma would receive
 * three structurally different queries.
 */
function setupReservationsFindMany(
  prisma: ReturnType<typeof makePrismaMock>,
  opts: {
    list?: Array<{ user_id: string | null; guests: number }>;
    historicalByEvent?: Record<string, ReturnType<typeof historicalRow>[]>;
    personalRows?: Array<{ user_id: string; checkin_entry_id: string | null }>;
  },
) {
  const { list = [], historicalByEvent = {}, personalRows = [] } = opts;
  prisma.reservations.findMany.mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    if (where.user_id) return personalRows;
    if (where.event_id && typeof where.event_id === 'object' && 'in' in where.event_id) {
      const ids: string[] = where.event_id.in;
      return ids.flatMap((id) => historicalByEvent[id] ?? []);
    }
    if (typeof where.event_id === 'string') return list;
    return [];
  });
}

function setupEntryCounts(
  prisma: ReturnType<typeof makePrismaMock>,
  countsByEvent: Record<string, number>,
) {
  prisma.entries.groupBy.mockResolvedValue(
    Object.entries(countsByEvent).map(([event_id, count]) => ({
      event_id,
      _count: { _all: count },
    })),
  );
}

describe('AttendanceForecastService', () => {
  let service: AttendanceForecastService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceForecastService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = module.get(AttendanceForecastService);

    prisma.event_forecasts.findFirst.mockResolvedValue(null);
    prisma.event_forecasts.create.mockResolvedValue({});
    setupReservationsFindMany(prisma, {});
    setupEntryCounts(prisma, {});
  });

  const targetEvent = {
    id: 'target-event',
    venue_id: 'venue-1',
    date: new Date('2026-08-21T20:00:00.000Z'), // Friday
  };

  it('throws NotFoundException when the event does not exist', async () => {
    prisma.events.findUnique.mockResolvedValue(null);
    await expect(service.getAttendanceForecast('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns the cached forecast without hitting the historical queries when fresh', async () => {
    prisma.event_forecasts.findFirst.mockResolvedValue({
      generated_at: new Date(),
      predicted_value: { toString: () => '120' } as any,
      lower_bound: { toString: () => '100' } as any,
      upper_bound: { toString: () => '140' } as any,
      confidence_score: { toString: () => '0.6' } as any,
      features_snapshot: {
        people_in_list: 150,
        predicted_from_list: 105,
        expected_walkins: 10,
        personalized_share: 0.4,
        sample_size: 5,
        sample_basis: 'venue_weekday',
      },
    });

    const result = await service.getAttendanceForecast('target-event');

    expect(result.predicted_value).toBe(120);
    expect(result.predicted_from_list).toBe(105);
    expect(result.expected_walkins).toBe(10);
    expect(result.personalized_share).toBe(0.4);
    expect(result.sample_basis).toBe('venue_weekday');
    expect(prisma.events.findUnique).not.toHaveBeenCalled();
  });

  it('ignores a cached row past the 1h TTL and recomputes', async () => {
    prisma.event_forecasts.findFirst.mockResolvedValue({
      generated_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      predicted_value: { toString: () => '999' } as any,
      lower_bound: { toString: () => '0' } as any,
      upper_bound: { toString: () => '0' } as any,
      confidence_score: { toString: () => '0' } as any,
      features_snapshot: {},
    });
    prisma.events.findUnique.mockResolvedValue(targetEvent);
    prisma.events.findMany.mockResolvedValue([]);

    const result = await service.getAttendanceForecast('target-event');

    expect(result.sample_basis).toBe('default');
    expect(prisma.events.findUnique).toHaveBeenCalled();
  });

  describe('cascade fallback (no personalization - list has only guest/no-history reservations)', () => {
    beforeEach(() => {
      prisma.events.findUnique.mockResolvedValue(targetEvent);
    });

    it('uses venue_weekday when 3+ same-weekday events have usable history', async () => {
      // Three past Fridays at this venue, each with 10 in the list and 6 checked in.
      const pastFridays = [
        { id: 'e1', date: new Date('2026-08-14T20:00:00.000Z') },
        { id: 'e2', date: new Date('2026-08-07T20:00:00.000Z') },
        { id: 'e3', date: new Date('2026-07-31T20:00:00.000Z') },
      ];
      prisma.events.findMany.mockResolvedValueOnce(pastFridays);

      const historicalByEvent = Object.fromEntries(
        pastFridays.map((e) => [
          e.id,
          [
            ...Array.from({ length: 4 }, () => historicalRow({ event_id: e.id })),
            ...Array.from({ length: 6 }, () =>
              historicalRow({ event_id: e.id, checkin_entry_id: 'entry-x' }),
            ),
          ],
        ]),
      );
      setupReservationsFindMany(prisma, {
        list: [{ user_id: null, guests: 20 }],
        historicalByEvent,
      });
      setupEntryCounts(prisma, Object.fromEntries(pastFridays.map((e) => [e.id, 6])));

      const result = await service.getAttendanceForecast('target-event');

      expect(result.sample_basis).toBe('venue_weekday');
      expect(result.show_up_rate).toBeCloseTo(0.6);
      expect(result.expected_walkins).toBe(0);
      expect(result.people_in_list).toBe(20);
      expect(result.predicted_from_list).toBe(12); // 0.6 * 20
      expect(result.personalized_share).toBe(0);
    });

    it('falls back to venue_any_day when same-weekday sample is too small', async () => {
      const pastEvents = [
        { id: 'e1', date: new Date('2026-08-19T20:00:00.000Z') }, // Wed
        { id: 'e2', date: new Date('2026-08-18T20:00:00.000Z') }, // Tue
        { id: 'e3', date: new Date('2026-08-17T20:00:00.000Z') }, // Mon
      ];
      prisma.events.findMany.mockResolvedValueOnce(pastEvents); // venue query

      const historicalByEvent = Object.fromEntries(
        pastEvents.map((e) => [
          e.id,
          [
            historicalRow({ event_id: e.id, guests: 10 }),
            historicalRow({
              event_id: e.id,
              guests: 10,
              checkin_entry_id: 'entry-x',
              actual_guests: 7,
            }),
          ],
        ]),
      );
      setupReservationsFindMany(prisma, {
        list: [{ user_id: null, guests: 5 }],
        historicalByEvent,
      });
      setupEntryCounts(prisma, Object.fromEntries(pastEvents.map((e) => [e.id, 7])));

      const result = await service.getAttendanceForecast('target-event');

      expect(result.sample_basis).toBe('venue_any_day');
    });

    it('falls back to global when the venue has no usable history at all', async () => {
      prisma.events.findMany
        .mockResolvedValueOnce([]) // venue query: nothing at this venue
        .mockResolvedValueOnce([{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }]); // global query

      const globalIds = ['g1', 'g2', 'g3'];
      const historicalByEvent = Object.fromEntries(
        globalIds.map((id) => [
          id,
          [
            historicalRow({ event_id: id, guests: 4 }),
            historicalRow({ event_id: id, guests: 4, checkin_entry_id: 'entry-x' }),
          ],
        ]),
      );
      setupReservationsFindMany(prisma, {
        list: [{ user_id: null, guests: 8 }],
        historicalByEvent,
      });
      setupEntryCounts(prisma, Object.fromEntries(globalIds.map((id) => [id, 4])));

      const result = await service.getAttendanceForecast('target-event');

      expect(result.sample_basis).toBe('global');
    });

    it('uses the fixed default rate with low confidence when there is zero history anywhere', async () => {
      prisma.events.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      setupReservationsFindMany(prisma, { list: [] });

      const result = await service.getAttendanceForecast('target-event');

      expect(result.sample_basis).toBe('default');
      expect(result.show_up_rate).toBe(0.7);
      expect(result.confidence_score).toBe(0.1);
      expect(result.expected_walkins).toBe(0);
    });
  });

  describe('numerator correctness (the P1 fix)', () => {
    const pastEvents = [
      { id: 'e1', date: new Date('2026-08-14T20:00:00.000Z') },
      { id: 'e2', date: new Date('2026-08-07T20:00:00.000Z') },
      { id: 'e3', date: new Date('2026-07-31T20:00:00.000Z') },
    ];

    beforeEach(() => {
      prisma.events.findUnique.mockResolvedValue(targetEvent);
      prisma.events.findMany.mockResolvedValueOnce(pastEvents);
    });

    it('does not count a staff walk-in (no reservation, entries row with any method) as a list check-in', async () => {
      // Each event: 10 people in list, 5 of them actually checked in via the list
      // (checkin_entry_id set), plus 3 physical entries with no reservation link at all -
      // regardless of how staff.service.ts tagged their `method`. Total entries per event = 8.
      const historicalByEvent = Object.fromEntries(
        pastEvents.map((e) => [
          e.id,
          [
            ...Array.from({ length: 5 }, () => historicalRow({ event_id: e.id })),
            ...Array.from({ length: 5 }, () =>
              historicalRow({ event_id: e.id, checkin_entry_id: 'entry-x' }),
            ),
          ],
        ]),
      );
      setupReservationsFindMany(prisma, {
        list: [{ user_id: null, guests: 10 }],
        historicalByEvent,
      });
      setupEntryCounts(prisma, Object.fromEntries(pastEvents.map((e) => [e.id, 8])));

      const result = await service.getAttendanceForecast('target-event');

      // Rate must come out to 5/10 = 0.5, not 8/10 - the 3 unlinked walk-ins must not inflate
      // the list show-up rate, they belong in expected_walkins instead.
      expect(result.show_up_rate).toBeCloseTo(0.5);
      expect(result.expected_walkins).toBe(3);
    });

    it('trusts actual_guests over guests for a group check-in', async () => {
      // One group reservation of 4 booked, only 3 actually walked in (staff corrected at the
      // door), plus 6 solo reservations that all showed up.
      const historicalByEvent = Object.fromEntries(
        pastEvents.map((e) => [
          e.id,
          [
            historicalRow({ event_id: e.id, guests: 4, checkin_entry_id: 'entry-g', actual_guests: 3 }),
            ...Array.from({ length: 6 }, () =>
              historicalRow({ event_id: e.id, guests: 1, checkin_entry_id: 'entry-x' }),
            ),
          ],
        ]),
      );
      setupReservationsFindMany(prisma, {
        list: [{ user_id: null, guests: 10 }],
        historicalByEvent,
      });
      setupEntryCounts(prisma, Object.fromEntries(pastEvents.map((e) => [e.id, 9])));

      const result = await service.getAttendanceForecast('target-event');

      // list = 4 + 6 = 10, checked in = 3 + 6 = 9 -> rate 0.9
      expect(result.show_up_rate).toBeCloseTo(0.9);
    });
  });

  describe('Pista 1 - personal per-user rate', () => {
    const pastEvents = [
      { id: 'e1', date: new Date('2026-08-14T20:00:00.000Z') },
      { id: 'e2', date: new Date('2026-08-07T20:00:00.000Z') },
      { id: 'e3', date: new Date('2026-07-31T20:00:00.000Z') },
    ];
    // Venue average across these 3 past events: 30 in list, 15 checked in -> 0.5.
    const venueHistoricalByEvent = Object.fromEntries(
      pastEvents.map((e) => [
        e.id,
        [
          ...Array.from({ length: 5 }, () => historicalRow({ event_id: e.id })),
          ...Array.from({ length: 5 }, () =>
            historicalRow({ event_id: e.id, checkin_entry_id: 'entry-x' }),
          ),
        ],
      ]),
    );

    beforeEach(() => {
      prisma.events.findUnique.mockResolvedValue(targetEvent);
      prisma.events.findMany.mockResolvedValueOnce(pastEvents);
      setupEntryCounts(prisma, Object.fromEntries(pastEvents.map((e) => [e.id, 5])));
    });

    it('applies a reliable user\'s own rate instead of the venue average', async () => {
      // luca-1 has 4 past entry reservations elsewhere, always checked in -> personal rate 1.0.
      // Venue average is 0.5 - a naive forecast would predict 0.5 for luca-1 too.
      setupReservationsFindMany(prisma, {
        list: [{ user_id: 'luca-1', guests: 1 }],
        historicalByEvent: venueHistoricalByEvent,
        personalRows: [
          { user_id: 'luca-1', checkin_entry_id: 'e-a' },
          { user_id: 'luca-1', checkin_entry_id: 'e-b' },
          { user_id: 'luca-1', checkin_entry_id: 'e-c' },
          { user_id: 'luca-1', checkin_entry_id: 'e-d' },
        ],
      });

      const result = await service.getAttendanceForecast('target-event');

      expect(result.predicted_from_list).toBe(1); // 1.0 * 1, not 0.5 * 1
      expect(result.personalized_share).toBe(1);
    });

    it('falls back to the venue average for a user below MIN_PERSONAL_SAMPLES', async () => {
      // marco-1 only has 2 past reservations - below the trust threshold of 3.
      setupReservationsFindMany(prisma, {
        list: [{ user_id: 'marco-1', guests: 1 }],
        historicalByEvent: venueHistoricalByEvent,
        personalRows: [
          { user_id: 'marco-1', checkin_entry_id: 'e-a' },
          { user_id: 'marco-1', checkin_entry_id: 'e-b' },
        ],
      });

      const result = await service.getAttendanceForecast('target-event');

      expect(result.show_up_rate).toBeCloseTo(0.5); // falls back to the venue rate
      expect(result.personalized_share).toBe(0);
    });

    it('never personalizes a guest reservation with no user_id', async () => {
      setupReservationsFindMany(prisma, {
        list: [{ user_id: null, guests: 1 }],
        historicalByEvent: venueHistoricalByEvent,
        personalRows: [],
      });

      const result = await service.getAttendanceForecast('target-event');

      expect(result.show_up_rate).toBeCloseTo(0.5);
      expect(result.personalized_share).toBe(0);
      // No personal-rate lookup should ever be issued for a null user_id.
      expect(prisma.reservations.findMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ user_id: expect.anything() }) }),
      );
    });

    it('blends personalized and non-personalized guests correctly across a mixed list', async () => {
      // luca-1: reliable (1.0), 3 guests booked under his reservation.
      // A guest reservation with no account: falls back to venue average (0.5), 2 guests.
      setupReservationsFindMany(prisma, {
        list: [
          { user_id: 'luca-1', guests: 3 },
          { user_id: null, guests: 2 },
        ],
        historicalByEvent: venueHistoricalByEvent,
        personalRows: [
          { user_id: 'luca-1', checkin_entry_id: 'e-a' },
          { user_id: 'luca-1', checkin_entry_id: 'e-b' },
          { user_id: 'luca-1', checkin_entry_id: 'e-c' },
        ],
      });

      const result = await service.getAttendanceForecast('target-event');

      // luca-1: 1.0 * 3 = 3, guest: 0.5 * 2 = 1 -> 4 total
      expect(result.predicted_from_list).toBe(4);
      expect(result.people_in_list).toBe(5);
      expect(result.personalized_share).toBeCloseTo(3 / 5);
    });

    it('excludes the event being forecast from a user\'s own history', async () => {
      setupReservationsFindMany(prisma, {
        list: [{ user_id: 'luca-1', guests: 1 }],
        historicalByEvent: venueHistoricalByEvent,
        personalRows: [
          { user_id: 'luca-1', checkin_entry_id: 'e-a' },
          { user_id: 'luca-1', checkin_entry_id: 'e-b' },
          { user_id: 'luca-1', checkin_entry_id: 'e-c' },
        ],
      });

      await service.getAttendanceForecast('target-event');

      expect(prisma.reservations.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ event_id: { not: 'target-event' } }),
        }),
      );
    });

    it("bounds a user's own history to the last 365 days", async () => {
      setupReservationsFindMany(prisma, {
        list: [{ user_id: 'luca-1', guests: 1 }],
        historicalByEvent: venueHistoricalByEvent,
        personalRows: [
          { user_id: 'luca-1', checkin_entry_id: 'e-a' },
          { user_id: 'luca-1', checkin_entry_id: 'e-b' },
          { user_id: 'luca-1', checkin_entry_id: 'e-c' },
        ],
      });

      await service.getAttendanceForecast('target-event');

      const personalCall = prisma.reservations.findMany.mock.calls.find(
        ([args]: [any]) => !!args?.where?.user_id,
      );
      const dateFilter = personalCall?.[0]?.where?.event?.date;
      expect(dateFilter?.lt).toEqual(targetEvent.date);
      const expectedCutoff = new Date(targetEvent.date);
      expectedCutoff.setDate(expectedCutoff.getDate() - 365);
      expect(dateFilter?.gte).toEqual(expectedCutoff);
    });
  });
});
