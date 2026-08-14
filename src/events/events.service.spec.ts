import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { EventStatus } from '@prisma/client';
import { EventsService } from './events.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseStorageService } from '../common/storage/supabase-storage.service';
import { ExpoPushService } from '../common/push/expo-push.service';

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
  let expoPush: { send: jest.Mock };

  beforeEach(async () => {
    prisma = makePrismaMock();
    expoPush = { send: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SupabaseStorageService, useValue: {} },
        { provide: ExpoPushService, useValue: expoPush },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
  });

  describe('cancelEvent', () => {
    it('marks the event CANCELLED, cancels its reservations, and notifies holders', async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'event-1',
        name: 'Sabato sera',
        status: EventStatus.LIVE,
      });
      prisma.reservations.findMany.mockResolvedValue([
        { id: 'res-1', user: { push_token: 'ExponentPushToken[abc]' } },
        { id: 'res-2', user: { push_token: null } },
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
      // Only the reservation whose user actually has a push token gets notified.
      expect(expoPush.send).toHaveBeenCalledTimes(1);
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
      expect(expoPush.send).not.toHaveBeenCalled();
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
});
