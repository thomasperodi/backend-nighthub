import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PromosController } from './promos.controller';
import { PromosService } from './promos.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushDispatchService } from '../common/push/push-dispatch.service';
import type { RequestUser } from '../auth/types';

const EVENTS: Record<
  string,
  { venue_id: string; organization_id: string | null }
> = {
  'event-org1': { venue_id: 'venue-A', organization_id: 'org-1' },
  'event-org2': { venue_id: 'venue-A', organization_id: 'org-2' },
  'event-venue': { venue_id: 'venue-A', organization_id: null },
};

function setup() {
  const prisma = {
    events: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(EVENTS[where.id] ?? null),
      ),
    },
    promos: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'promo-1', ...data }),
      ),
      findUnique: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    // No push recipients: keeps the fire-and-forget push a no-op.
    users: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const service = new PromosService(
    prisma as unknown as PrismaService,
    { notifyUser: jest.fn() } as unknown as PushDispatchService,
  );
  return { prisma, controller: new PromosController(service) };
}

const org1 = {
  id: 'u1',
  role: 'organization',
  venue_id: null,
  organization_id: 'org-1',
} as RequestUser;
const venueA = {
  id: 'u2',
  role: 'venue',
  venue_id: 'venue-A',
  organization_id: null,
} as RequestUser;
const base = { title: 'Drink 2x1', discount_type: 'free' as const };

describe('Promos: who can manage what', () => {
  it('an organization creates promos on its own nights, at that night’s venue', async () => {
    const { controller, prisma } = setup();
    await controller.create({ ...base, event_id: 'event-org1' }, org1);
    expect(prisma.promos.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        venue_id: 'venue-A',
        event_id: 'event-org1',
      }) as unknown,
    });
  });

  it('an organization must pick a night, and only one of its own', async () => {
    const { controller } = setup();
    await expect(controller.create(base, org1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      controller.create({ ...base, event_id: 'event-org2' }, org1),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      controller.create({ ...base, event_id: 'event-venue' }, org1),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a venue always creates on its own venue, whatever venue_id it sends', async () => {
    const { controller, prisma } = setup();
    await controller.create({ ...base, venue_id: 'venue-OTHER' }, venueA);
    expect(prisma.promos.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ venue_id: 'venue-A' }) as unknown,
    });
  });

  it('an organization cannot touch a venue-wide promo', async () => {
    const { controller, prisma } = setup();
    prisma.promos.findUnique.mockResolvedValue({
      id: 'p',
      venue_id: 'venue-A',
      event_id: null,
    });
    await expect(controller.delete('p', org1)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.promos.delete).not.toHaveBeenCalled();
  });

  it('validates the discount: percentage 1-100, fixed > 0', async () => {
    const { controller } = setup();
    await expect(
      controller.create(
        { title: 'Sconto', discount_type: 'percentage', discount_value: 150 },
        venueA,
      ),
    ).rejects.toThrow('Lo sconto non può superare il 100%.');
    await expect(
      controller.create({ title: 'Sconto', discount_type: 'fixed' }, venueA),
    ).rejects.toThrow('Indica l’importo dello sconto.');
  });

  it('audience "none" sends no push at all', async () => {
    const { controller, prisma } = setup();
    await controller.create({ ...base, audience: 'none' }, venueA);
    await new Promise((r) => setImmediate(r));
    expect(prisma.users.findMany).not.toHaveBeenCalled();
  });
});
