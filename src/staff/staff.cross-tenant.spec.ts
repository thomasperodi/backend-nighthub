import { ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { StaffController } from './staff.controller';
import type { StaffService } from './staff.service';
import type { EventsService } from '../events/events.service';
import type { RequestUser } from '../auth/types';

// Cross-tenant guard rails for the staff API: an account of venue A must never read or
// write data of venue B by passing one of B's event or table ids. The ownership checks are
// copy-pasted per endpoint in StaffController, so these tests pin the wiring (the controller
// passes the caller's venue and never returns/writes data when the check fails).

const OWNER: Record<string, string> = {
  'event-A': 'venue-A',
  'event-B': 'venue-B',
  'table-A': 'venue-A',
  'table-B': 'venue-B',
};

// async like the real service methods: a failed check is a rejected promise.
async function assertOwner(id: string, venueId: string) {
  await Promise.resolve();
  if (OWNER[id] !== venueId) throw new ForbiddenException('Forbidden');
}

function makeStaffService() {
  const data = jest.fn().mockResolvedValue(['secret rows']);
  const write = jest.fn().mockResolvedValue({ success: true });
  const service = {
    assertEventBelongsToVenue: jest.fn(assertOwner),
    assertEventTableBelongsToVenue: jest.fn(assertOwner),
    // Same contract as the real one: an explicit eventId is validated against the venue.
    resolveEventIdForStaffApi: jest.fn(
      async (p: { eventId?: string; expectedVenueId?: string }) => {
        if (p.eventId && p.expectedVenueId)
          await assertOwner(p.eventId, p.expectedVenueId);
        return p.eventId ?? 'event-A';
      },
    ),
    listEntries: data,
    listBarSales: data,
    listCloakroomSales: data,
    recordEntry: write,
    recordBarSale: write,
    recordCloakroomSale: write,
    addTablePayment: write,
    createTableBottleOrder: write,
    updateHostessTableEntrati: write,
  };
  return { service, data, write };
}

const staffOfA: RequestUser = {
  id: 'staff-1',
  role: 'staff',
  venue_id: 'venue-A',
  organization_id: null,
} as RequestUser;

describe('StaffController: cross-tenant access', () => {
  let controller: StaffController;
  let data: jest.Mock;
  let write: jest.Mock;
  let getEventStats: jest.Mock;

  beforeEach(() => {
    const staff = makeStaffService();
    data = staff.data;
    write = staff.write;
    getEventStats = jest.fn().mockResolvedValue({ total_bar: 1000 });
    controller = new StaffController(
      staff.service as unknown as StaffService,
      { getEventStats } as unknown as EventsService,
    );
  });

  it.each([
    ['entries', (c: StaffController) => c.listEntries(staffOfA, 'event-B')],
    ['bar-sales', (c: StaffController) => c.listBarSales(staffOfA, 'event-B')],
    [
      'cloakroom-sales',
      (c: StaffController) => c.listCloakroomSales(staffOfA, 'event-B'),
    ],
  ])('GET %s?eventId=<other venue> → 403, no data', async (_, call) => {
    await expect(call(controller)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('GET events/:id/stats of another venue → 403, stats never computed', async () => {
    await expect(
      controller.eventStats('event-B', staffOfA, {
        setHeader: jest.fn(),
      } as unknown as Response),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(getEventStats).not.toHaveBeenCalled();
  });

  it.each([
    [
      'POST entries',
      (c: StaffController) =>
        c.recordEntry({ event_id: 'event-B' } as never, staffOfA),
    ],
    [
      'POST bar-sales',
      (c: StaffController) =>
        c.recordBarSale({ event_id: 'event-B', amount: 10 } as never, staffOfA),
    ],
    [
      'POST waiter payment',
      (c: StaffController) =>
        c.addTablePayment('table-B', { amount: 50 } as never, staffOfA),
    ],
    [
      'POST bottle order',
      (c: StaffController) =>
        c.createTableBottleOrder(
          'table-B',
          { bottle_name: 'X' } as never,
          staffOfA,
        ),
    ],
    [
      'POST hostess update-entrati',
      (c: StaffController) =>
        c.updateHostessTableEntrati('table-B', { delta: 1 }, staffOfA),
    ],
  ])('%s on another venue → 403, nothing written', async (_, call) => {
    await expect(call(controller)).rejects.toBeInstanceOf(ForbiddenException);
    expect(write).not.toHaveBeenCalled();
  });

  it('own venue works (sanity check of the fake)', async () => {
    await expect(controller.listEntries(staffOfA, 'event-A')).resolves.toEqual([
      'secret rows',
    ]);
    expect(data).toHaveBeenCalledWith('event-A');
  });
});
