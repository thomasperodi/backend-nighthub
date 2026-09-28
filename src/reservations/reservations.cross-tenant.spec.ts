import { ForbiddenException } from '@nestjs/common';
import { ReservationsController } from './reservations.controller';
import type { ReservationsService } from './reservations.service';
import type { RequestUser } from '../auth/types';

// Cross-tenant guard rails for reservations: guest lists and QR check-in of venue B must be
// out of reach for venue A's accounts, and a client only ever sees their own reservations.

const EVENT_VENUE: Record<string, string> = {
  'event-A': 'venue-A',
  'event-B': 'venue-B',
};

const user = (role: string, extra: Partial<RequestUser> = {}) =>
  ({
    id: `${role}-1`,
    role,
    venue_id: null,
    organization_id: null,
    ...extra,
  }) as RequestUser;

describe('ReservationsController: cross-tenant access', () => {
  let controller: ReservationsController;
  let service: Record<string, jest.Mock>;

  beforeEach(() => {
    service = {
      // async like the real one: a failed check is a rejected promise.
      assertEventBelongsToVenue: jest.fn(
        async (eventId: string, venueId: string) => {
          await Promise.resolve();
          if (EVENT_VENUE[eventId] !== venueId)
            throw new ForbiddenException('Forbidden');
        },
      ),
      listReservations: jest.fn().mockResolvedValue(['guest list']),
      getReservation: jest.fn().mockResolvedValue({
        id: 'r1',
        user_id: 'someone-else',
        event: { venue_id: 'venue-B' },
      }),
      checkInEntryReservationByQr: jest.fn().mockResolvedValue({}),
    };
    controller = new ReservationsController(
      service as unknown as ReservationsService,
    );
  });

  const venueA = user('venue', { venue_id: 'venue-A' });
  const staffA = user('staff', { venue_id: 'venue-A' });

  it("the guest list of another venue's event → 403, list never read", async () => {
    await expect(
      Promise.resolve(controller.list(venueA, 'event-B')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.listReservations).not.toHaveBeenCalled();
  });

  it("a reservation of another venue's event → 403", async () => {
    await expect(controller.get('r1', staffA)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("a client can't open someone else's reservation", async () => {
    await expect(controller.get('r1', user('client'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("scanning a QR for another venue's event → 403, no check-in", async () => {
    await expect(
      controller.scanEntryQr({ event_id: 'event-B', qr_data: 'token' }, staffA),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.checkInEntryReservationByQr).not.toHaveBeenCalled();
  });

  it('own venue works (sanity check of the fake)', async () => {
    await expect(
      Promise.resolve(controller.list(venueA, 'event-A')),
    ).resolves.toEqual(['guest list']);
  });
});
