import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadgesService } from '../badges/badges.service';
import { PushDispatchService } from '../common/push/push-dispatch.service';
import { VenueStaysService } from '../venue-stays/venue-stays.service';

// Organization & PR rework: "ingressi portati" must follow the guest from the PR's link to
// the door, and the season pass is per venue.

const MEMBERSHIP = '44444444-4444-4444-8444-444444444444';

function makePrismaMock() {
  return {
    reservations: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    users: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    events: { findUnique: jest.fn().mockResolvedValue(null) },
    event_entry_prices: { findMany: jest.fn().mockResolvedValue([]) },
    entries: { create: jest.fn() },
    venue_pr_memberships: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
}

describe('ReservationsService PR attribution', () => {
  let service: ReservationsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  const reservation = (meta: unknown, guests = 3) => ({
    id: 'res-1',
    user_id: 'guest-1',
    event_id: 'event-1',
    type: 'entry' as const,
    status: 'confirmed',
    guests,
    qr_token: 'token-1',
    checked_in_at: null,
    total_amount: 0, // complimentary: resolveEntryUnitPrice needs no price lookup
    meta,
    user: { id: 'guest-1', sesso: null, name: 'Giulia', birth_date: null },
    event: {
      id: 'event-1',
      name: 'Sabato',
      venue_id: 'venue-1',
      date: new Date(),
    },
  });

  type EntryData = { pr_membership_id?: string | null };

  /** Runs the check-in transaction against in-memory mocks; returns the created entries. */
  function mockCheckInTransaction(): EntryData[] {
    const created: EntryData[] = [];
    const create = ({ data }: { data: EntryData }) => {
      created.push(data);
      return Promise.resolve({ id: `entry-${created.length}`, ...data });
    };
    prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({
        reservations: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn().mockResolvedValue({ id: 'res-1' }),
        },
        entries: { create },
      }),
    );
    return created;
  }

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: BadgesService,
          useValue: { evaluateForUser: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PushDispatchService,
          useValue: { notifyUser: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: VenueStaysService,
          useValue: {
            startStayOnCheckIn: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = module.get(ReservationsService);
  });

  describe('1.3 check-in of a reservation booked through a PR link', () => {
    it('attributes every entry of the group to the PR', async () => {
      prisma.reservations.findUnique.mockResolvedValue(
        reservation({ pr_membership_id: MEMBERSHIP }, 3),
      );
      prisma.venue_pr_memberships.findUnique.mockResolvedValue({
        id: MEMBERSHIP,
      });
      const created = mockCheckInTransaction();

      const result = await service.checkInEntryReservationByQr({
        eventId: 'event-1',
        staffId: 'staff-1',
        qrData: 'token-1',
      });

      expect(result.alreadyCheckedIn).toBe(false);
      expect(created).toHaveLength(3);
      for (const data of created) {
        expect(data.pr_membership_id).toBe(MEMBERSHIP);
      }
    });

    it('does not attribute when the membership no longer exists (no FK failure at the door)', async () => {
      prisma.reservations.findUnique.mockResolvedValue(
        reservation({ pr_membership_id: MEMBERSHIP }, 1),
      );
      prisma.venue_pr_memberships.findUnique.mockResolvedValue(null);
      const created = mockCheckInTransaction();

      await service.checkInEntryReservationByQr({
        eventId: 'event-1',
        staffId: 'staff-1',
        qrData: 'token-1',
      });

      expect(created[0].pr_membership_id).toBeNull();
    });

    it('ignores a malformed pr_membership_id without querying it', async () => {
      prisma.reservations.findUnique.mockResolvedValue(
        reservation({ pr_membership_id: "x' OR 1=1" }, 1),
      );
      const created = mockCheckInTransaction();

      await service.checkInEntryReservationByQr({
        eventId: 'event-1',
        staffId: 'staff-1',
        qrData: 'token-1',
      });

      expect(prisma.venue_pr_memberships.findUnique).not.toHaveBeenCalled();
      expect(created[0].pr_membership_id).toBeNull();
    });
  });

  describe('1.6 a deactivated PR stops attributing', () => {
    it('only resolves referral codes of active memberships', async () => {
      prisma.venue_pr_memberships.findFirst.mockResolvedValue(null);

      const result = await (
        service as unknown as {
          resolveReferralAttribution: (
            p: unknown,
          ) => Promise<{ referralMeta: unknown; prMembership: unknown }>;
        }
      ).resolveReferralAttribution({
        venueId: 'venue-1',
        meta: { ref_code: 'ELENA-3MK8QW' },
        type: 'entry',
      });

      expect(prisma.venue_pr_memberships.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ is_active: true }) as unknown,
        }),
      );
      expect(result.prMembership).toBeNull();
      expect(result.referralMeta).toBeNull();
    });
  });

  describe('1.7 season pass is per venue', () => {
    it('refuses a pass issued by another venue, even for the same organization PR', async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'event-2',
        venue_id: 'venue-2',
        date: new Date(),
      });
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'pass-1',
          venue_id: 'venue-1',
          pr_membership_id: MEMBERSHIP,
          user_id: 'pr-user',
          status: 'active',
          valid_from: new Date(Date.now() - 86_400_000),
          valid_until: new Date(Date.now() + 86_400_000),
          revoked_at: null,
          qr_token: 'pass-token',
          membership_is_active: true,
        },
      ]);

      await expect(
        service.checkInEntryReservationByQr({
          eventId: 'event-2',
          staffId: 'staff-1',
          qrData: JSON.stringify({
            type: 'pr_season_pass',
            qr_token: 'pass-token',
          }),
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
