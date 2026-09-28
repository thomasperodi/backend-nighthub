import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadgesService } from '../badges/badges.service';
import { PushDispatchService } from '../common/push/push-dispatch.service';

function makePrismaMock() {
  return {
    reservations: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    users: { findMany: jest.fn().mockResolvedValue([]) },
    events: { findUnique: jest.fn().mockResolvedValue(null) },
    event_entry_prices: { findMany: jest.fn().mockResolvedValue([]) },
    entries: { create: jest.fn() },
    $transaction: jest.fn(),
  };
}

describe('ReservationsService', () => {
  let service: ReservationsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  const baseReservation = {
    id: 'res-1',
    user_id: 'user-1',
    event_id: 'event-1',
    venue_table_zone_id: 'zone-1',
    table_name: 'Tavolo 1',
    meta: null,
    type: 'table' as const,
    status: 'pending',
    guests: 4,
    actual_guests: null,
    total_amount: null,
    qr_token: null,
    qr_payload: null,
    checked_in_at: null,
    checked_in_by_staff_id: null,
    checkin_entry_id: null,
    created_at: new Date('2026-08-01T20:00:00Z'),
    user: { id: 'user-1', name: 'Mario', email: 'm@x.it', phone: null },
    event: {
      id: 'event-1',
      venue_id: 'venue-1',
      name: 'Sabato sera',
      date: new Date('2026-08-15'),
      start_time: null,
      end_time: null,
      venue: {
        id: 'venue-1',
        name: 'Club X',
        city: 'Roma',
        address: null,
        latitude: null,
        longitude: null,
        image: null,
      },
    },
    venue_table_zone: null,
  };

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
      ],
    }).compile();

    service = module.get<ReservationsService>(ReservationsService);
  });

  describe('status transition guard (updateReservation)', () => {
    it('allows pending -> confirmed', async () => {
      prisma.reservations.findUnique
        .mockResolvedValueOnce({ ...baseReservation, status: 'pending' })
        .mockResolvedValueOnce({ ...baseReservation, status: 'confirmed' });
      prisma.reservations.update.mockResolvedValue({
        ...baseReservation,
        status: 'confirmed',
      });

      await expect(
        service.updateReservation('res-1', { status: 'confirmed' }),
      ).resolves.toBeDefined();
      expect(prisma.reservations.update).toHaveBeenCalled();
    });

    it('rejects cancelled -> confirmed (no reviving a dead booking)', async () => {
      prisma.reservations.findUnique.mockResolvedValueOnce({
        ...baseReservation,
        status: 'cancelled',
      });

      await expect(
        service.updateReservation('res-1', { status: 'confirmed' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.reservations.update).not.toHaveBeenCalled();
    });

    it('rejects completed -> pending', async () => {
      prisma.reservations.findUnique.mockResolvedValueOnce({
        ...baseReservation,
        status: 'completed',
      });

      await expect(
        service.updateReservation('res-1', { status: 'pending' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('is a no-op guard when the status is unchanged', async () => {
      prisma.reservations.findUnique
        .mockResolvedValueOnce({ ...baseReservation, status: 'confirmed' })
        .mockResolvedValueOnce({ ...baseReservation, status: 'confirmed' });
      prisma.reservations.update.mockResolvedValue({
        ...baseReservation,
        status: 'confirmed',
      });

      await expect(
        service.updateReservation('res-1', { status: 'confirmed' }),
      ).resolves.toBeDefined();
    });
  });

  describe('checkInEntryReservationByQr (race on concurrent scans)', () => {
    const qrReservation = {
      id: 'res-qr-1',
      user_id: 'user-1',
      event_id: 'event-1',
      type: 'entry' as const,
      status: 'pending',
      qr_token: 'raw-token-abc',
      checked_in_at: null,
      total_amount: 0, // complimentary => resolveEntryUnitPrice short-circuits, no pricing lookups needed
      meta: null,
      user: { id: 'user-1', sesso: null, name: 'Mario', birth_date: null },
      event: {
        id: 'event-1',
        name: 'Sabato',
        venue_id: 'venue-1',
        date: new Date(),
      },
    };

    it('creates the entry and claims check-in when it wins the race', async () => {
      prisma.reservations.findUnique.mockResolvedValue(qrReservation);
      const createdEntry = { id: 'entry-1' };
      const updatedReservation = {
        ...qrReservation,
        status: 'completed',
        checked_in_at: new Date(),
      };

      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          reservations: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            update: jest.fn().mockResolvedValue(updatedReservation),
          },
          entries: { create: jest.fn().mockResolvedValue(createdEntry) },
        }),
      );

      const result = await service.checkInEntryReservationByQr({
        eventId: 'event-1',
        staffId: 'staff-1',
        qrData: 'raw-token-abc',
      });

      expect(result.alreadyCheckedIn).toBe(false);
      expect(result.entry).toEqual(createdEntry);
    });

    it('backs off without creating a duplicate entry when it loses the race', async () => {
      prisma.reservations.findUnique.mockResolvedValue(qrReservation);
      const entriesCreate = jest.fn();

      prisma.$transaction.mockImplementation(async (fn: any) =>
        fn({
          // count: 0 => another concurrent scan already claimed checked_in_at first.
          reservations: {
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
          },
          entries: { create: entriesCreate },
        }),
      );

      const result = await service.checkInEntryReservationByQr({
        eventId: 'event-1',
        staffId: 'staff-1',
        qrData: 'raw-token-abc',
      });

      expect(result.alreadyCheckedIn).toBe(true);
      expect(entriesCreate).not.toHaveBeenCalled();
    });
  });

  describe('expireStalePendingReservations', () => {
    it('cancels only pending table reservations older than the TTL', async () => {
      prisma.reservations.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.expireStalePendingReservations();

      expect(prisma.reservations.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: 'table',
            status: 'pending',
          }),
          data: { status: 'cancelled' },
        }),
      );
      expect(result).toEqual({ success: true, expired: 3 });
    });
  });

  describe('createReservation: event must still be bookable', () => {
    const pastNight = {
      id: 'event-1',
      venue_id: 'venue-1',
      name: 'Sabato sera',
      // Well in the past and without end_time: this used to stay DRAFT forever.
      date: new Date('2020-01-11'),
      start_time: new Date(Date.UTC(1970, 0, 1, 22, 0)),
      end_time: null,
      status: 'DRAFT',
    };
    const futureNight = { ...pastNight, date: new Date('2099-01-10') };
    const entry = {
      user_id: 'user-1',
      event_id: 'event-1',
      type: 'entry',
      guests: 1,
    };

    let users: { findUnique: jest.Mock };
    let findFirst: jest.Mock;

    beforeEach(() => {
      users = { findUnique: jest.fn().mockResolvedValue({ role: 'client' }) };
      findFirst = jest.fn().mockResolvedValue({ id: 'existing' });
      Object.assign(prisma.users, users);
      Object.assign(prisma.reservations, { findFirst });
    });

    it('rejects a client booking for a night that is already over', async () => {
      prisma.events.findUnique.mockResolvedValue(pastNight);
      await expect(service.createReservation(entry)).rejects.toThrow(
        'Questa serata è già conclusa',
      );
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('carries a stable code the app can switch on', async () => {
      prisma.events.findUnique.mockResolvedValue(pastNight);
      const err = (await service
        .createReservation(entry)
        .catch((e: unknown) => e)) as BadRequestException;
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: 'EVENT_CLOSED' }),
      );
    });

    it('rejects any booking for a cancelled event, even a future one', async () => {
      prisma.events.findUnique.mockResolvedValue({
        ...futureNight,
        status: 'CANCELLED',
      });
      await expect(service.createReservation(entry)).rejects.toThrow(
        'Questo evento è stato annullato',
      );
    });

    it('lets a venue account record a booking on a closed night', async () => {
      users.findUnique.mockResolvedValue({ role: 'venue' });
      prisma.events.findUnique.mockResolvedValue(pastNight);
      // Gets past the status check; whatever the (partially mocked) rest of the flow does
      // afterwards is out of scope here.
      const outcome: unknown = await service
        .createReservation(entry)
        .catch((e: unknown) => e);
      expect((outcome as Error | undefined)?.message).not.toBe(
        'Questa serata è già conclusa',
      );
    });

    it('lets a client book an upcoming night (reaches the duplicate check)', async () => {
      prisma.events.findUnique.mockResolvedValue(futureNight);
      await expect(service.createReservation(entry)).rejects.toThrow(
        'Sei già in lista per questa serata',
      );
      expect(findFirst).toHaveBeenCalled();
    });
  });
});
