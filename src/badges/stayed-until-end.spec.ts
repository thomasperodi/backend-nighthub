import { BadgesService } from './badges.service';
import type { PrismaService } from '../prisma/prisma.service';

const time = (h: number, m = 0) => new Date(Date.UTC(1970, 0, 1, h, m));

describe('Badge criterion stayed_until_end', () => {
  it('counts nights left in the last 30 minutes or later, measured exits only', async () => {
    const findManyStays = jest.fn().mockResolvedValue([
      // Night 1 ends 31 Aug 04:00 Rome = 02:00Z: left 01:45Z -> within the last 30 min.
      { event_id: 'e1', exited_at: new Date('2026-08-31T01:45:00Z') },
      // Night 2 ends 07 Sep 02:00Z: left at 23:00Z the night before -> too early.
      { event_id: 'e2', exited_at: new Date('2026-09-06T23:00:00Z') },
    ]);
    const prisma = {
      venue_stays: { findMany: findManyStays },
      events: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'e1',
            date: new Date(Date.UTC(2026, 7, 30)),
            start_time: time(22),
            end_time: time(4),
          },
          {
            id: 'e2',
            date: new Date(Date.UTC(2026, 8, 6)),
            start_time: time(22),
            end_time: time(4),
          },
        ]),
      },
    };
    const service = new BadgesService(prisma as unknown as PrismaService);
    const count = await (
      service as unknown as {
        countNightsStayedUntilEnd: (u: string, m: number) => Promise<number>;
      }
    ).countNightsStayedUntilEnd('user-1', 30);

    expect(count).toBe(1);
    // Only geofence exits are even read: estimated exits can never unlock it.
    expect(findManyStays).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ exit_source: 'geofence' }) as unknown,
      }),
    );
  });
});
