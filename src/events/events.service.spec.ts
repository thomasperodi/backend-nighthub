import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';
import { EventsService } from './events.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseStorageService } from '../common/storage/supabase-storage.service';
import { PushDispatchService } from '../common/push/push-dispatch.service';

function makePrismaMock() {
  return {
    events: {
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    },
    reservations: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      deleteMany: jest.fn(),
    },
    ticket_orders: { count: jest.fn() },
    event_entry_prices: { deleteMany: jest.fn() },
    user_promos: { deleteMany: jest.fn() },
    promos: { deleteMany: jest.fn() },
    bar_sales: { deleteMany: jest.fn() },
    cloakroom_sales: { deleteMany: jest.fn() },
    table_sales: { deleteMany: jest.fn() },
    entries: { deleteMany: jest.fn() },
    event_tables: { deleteMany: jest.fn() },
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
  };
}

describe('EventsService', () => {
  let service: EventsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let pushDispatch: { notifyUser: jest.Mock };

  beforeEach(async () => {
    prisma = makePrismaMock();
    pushDispatch = { notifyUser: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseStorageService, useValue: {} },
        { provide: PushDispatchService, useValue: pushDispatch },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  describe('cancelEvent', () => {
    it('marks the event CANCELLED, cancels its reservations, and notifies each holder once', async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'event-1',
        name: 'Sabato sera',
        status: EventStatus.LIVE,
      });
      prisma.reservations.findMany.mockResolvedValue([
        { id: 'res-1', user_id: 'user-1' },
        { id: 'res-2', user_id: 'user-2' },
      ]);

      const result = await service.cancelEvent('event-1');

      expect(prisma.events.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'event-1' },
          data: { status: EventStatus.CANCELLED },
        }),
      );
      expect(prisma.reservations.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { event_id: 'event-1', status: { not: 'cancelled' } },
          data: { status: 'cancelled' },
        }),
      );
      // PushDispatchService fans out to Expo and Web Push itself - one notifyUser call per
      // distinct affected user, regardless of which channel(s) they're reachable on.
      expect(pushDispatch.notifyUser).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ success: true, cancelled_reservations: 2 });
    });

    it('is idempotent when the event is already cancelled', async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'event-1',
        name: 'Sabato sera',
        status: EventStatus.CANCELLED,
      });

      const result = await service.cancelEvent('event-1');

      expect(result).toEqual({ success: true, already_cancelled: true });
      expect(prisma.events.update).not.toHaveBeenCalled();
      expect(pushDispatch.notifyUser).not.toHaveBeenCalled();
    });
  });

  describe('deleteEvent', () => {
    it('refuses to hard-delete an event with linked ticket orders or reservations', async () => {
      jest.spyOn(service, 'getEvent').mockResolvedValue({} as never);
      prisma.ticket_orders.count.mockResolvedValue(1);
      prisma.reservations.count.mockResolvedValue(0);

      await expect(service.deleteEvent('event-1')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('proceeds when nothing is linked to the event', async () => {
      jest.spyOn(service, 'getEvent').mockResolvedValue({} as never);
      prisma.ticket_orders.count.mockResolvedValue(0);
      prisma.reservations.count.mockResolvedValue(0);

      const result = await service.deleteEvent('event-1');

      expect(result).toEqual({ success: true });
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('getFriendsGoing', () => {
    it('non mostra gli amici che hanno nascosto le proprie serate', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      Object.assign(prisma, {
        friendships: {
          findMany: jest.fn().mockResolvedValue([{ friend_id: 'f1' }]),
        },
        users: { findMany },
      });
      prisma.reservations.findMany.mockResolvedValue([{ user_id: 'f1' }]);

      await service.getFriendsGoing('event-1', 'me');

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['f1'] }, nights_visible_to_friends: true },
        }),
      );
    });
  });

  describe('list shape (serializeListEvent)', () => {
    const serialize = (e: unknown) =>
      (
        service as unknown as {
          serializeListEvent: (e: unknown) => Record<string, unknown>;
        }
      ).serializeListEvent(e);
    const base = {
      id: 'event-1',
      date: new Date(Date.UTC(2099, 0, 10)),
      start_time: new Date(Date.UTC(1970, 0, 1, 23, 0)),
      end_time: null,
      status: EventStatus.DRAFT,
      venue: { id: 'v1', name: 'Paradise', image: null, city: 'Piacenza' },
      promos: [],
    };

    it('exposes the cheapest entry price and the city, not the price rules', () => {
      const out = serialize({
        ...base,
        entry_prices: [{ price: '15.00' }, { price: '10.00' }],
      });
      expect(out.min_entry_price).toBe(10);
      expect(out.entry_prices).toBeUndefined();
      expect(out.venue).toEqual(expect.objectContaining({ city: 'Piacenza' }));
    });

    it('is null when the venue has not published prices', () => {
      expect(
        serialize({ ...base, entry_prices: [] }).min_entry_price,
      ).toBeNull();
    });
  });
});
