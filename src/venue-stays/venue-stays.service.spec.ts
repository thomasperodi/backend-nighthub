import { VenueStaysService } from './venue-stays.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushDispatchService } from '../common/push/push-dispatch.service';

const time = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m));

function setup() {
  const prisma = {
    events: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    venue_stays: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const push = { notifyUser: jest.fn().mockResolvedValue(undefined) };
  const service = new VenueStaysService(
    prisma as unknown as PrismaService,
    push as unknown as PushDispatchService,
  );
  return { prisma, push, service };
}

describe('VenueStaysService', () => {
  describe('startStayOnCheckIn', () => {
    it('opens the stay and sends the venue area to the app', async () => {
      const { prisma, push, service } = setup();
      prisma.events.findUnique.mockResolvedValue({
        id: 'event-1',
        venue: {
          id: 'venue-1',
          name: 'Paradise',
          latitude: '45.05',
          longitude: '9.69',
          radius_geofence: 120,
        },
      });

      await service.startStayOnCheckIn('user-1', 'event-1');

      expect(prisma.venue_stays.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          user_id: 'user-1',
          venue_id: 'venue-1',
          event_id: 'event-1',
        }) as unknown,
      });
      expect(push.notifyUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          data: {
            type: 'venue_stay',
            venue_id: 'venue-1',
            event_id: 'event-1',
            latitude: 45.05,
            longitude: 9.69,
            radius: 120,
          },
        }),
      );
    });

    it('ends a stay still open at another venue (one place at a time)', async () => {
      const { prisma, service } = setup();
      prisma.events.findUnique.mockResolvedValue({
        id: 'event-2',
        venue: {
          id: 'venue-2',
          name: 'X',
          latitude: null,
          longitude: null,
          radius_geofence: 100,
        },
      });
      prisma.venue_stays.findMany.mockResolvedValueOnce([
        {
          id: 'old',
          entered_at: new Date(Date.now() - 3_600_000),
          event_id: null,
        },
      ]);

      await service.startStayOnCheckIn('user-1', 'event-2');

      expect(prisma.venue_stays.update).toHaveBeenCalledWith({
        where: { id: 'old' },
        data: expect.objectContaining({ exit_source: 'auto' }) as unknown,
      });
    });

    it('never breaks the check-in if something fails', async () => {
      const { prisma, service } = setup();
      prisma.events.findUnique.mockRejectedValue(new Error('db down'));
      await expect(
        service.startStayOnCheckIn('user-1', 'event-1'),
      ).resolves.toBeUndefined();
    });
  });

  describe('checkpoint exit', () => {
    it('records the exit reported by the app, never before the entry', async () => {
      const { prisma, service } = setup();
      const enteredAt = new Date('2026-09-26T21:00:00Z');
      prisma.venue_stays.findFirst.mockResolvedValue({
        id: 'stay-1',
        entered_at: enteredAt,
      });

      await service.checkpoint({
        user_id: 'user-1',
        venue_id: 'venue-1',
        event_type: 'exit',
        timestamp: '2026-09-26T20:00:00Z', // before the entry: clamped
        exit_source: 'geofence',
      });

      expect(prisma.venue_stays.update).toHaveBeenCalledWith({
        where: { id: 'stay-1' },
        data: {
          exited_at: enteredAt,
          duration_ms: 0,
          exit_source: 'geofence',
        },
      });
    });
  });

  describe('closeExpiredStays', () => {
    it('closes at the end of the night the stays the app never reported, as "auto"', async () => {
      const { prisma, service } = setup();
      const enteredAt = new Date('2026-08-30T21:00:00Z');
      prisma.venue_stays.findMany.mockResolvedValue([
        { id: 'stay-1', entered_at: enteredAt, event_id: 'event-1' },
      ]);
      prisma.events.findMany.mockResolvedValue([
        {
          id: 'event-1',
          date: new Date(Date.UTC(2026, 7, 30)),
          start_time: time(22),
          end_time: time(4), // 31 Aug 04:00 Rome = 02:00Z
        },
      ]);

      const result = await service.closeExpiredStays(
        new Date('2026-09-01T00:00:00Z').getTime(),
      );

      expect(result.closed).toBe(1);
      expect(prisma.venue_stays.update).toHaveBeenCalledWith({
        where: { id: 'stay-1' },
        data: {
          exited_at: new Date('2026-08-31T02:00:00Z'),
          duration_ms: 5 * 3_600_000,
          exit_source: 'auto',
        },
      });
    });

    it('leaves open the stays whose night is not over yet', async () => {
      const { prisma, service } = setup();
      prisma.venue_stays.findMany.mockResolvedValue([
        {
          id: 'stay-1',
          entered_at: new Date('2026-08-30T21:00:00Z'),
          event_id: 'event-1',
        },
      ]);
      prisma.events.findMany.mockResolvedValue([
        {
          id: 'event-1',
          date: new Date(Date.UTC(2026, 7, 30)),
          start_time: time(22),
          end_time: time(4),
        },
      ]);

      const result = await service.closeExpiredStays(
        new Date('2026-08-30T23:00:00Z').getTime(),
      );

      expect(result.closed).toBe(0);
      expect(prisma.venue_stays.update).not.toHaveBeenCalled();
    });
  });
});
