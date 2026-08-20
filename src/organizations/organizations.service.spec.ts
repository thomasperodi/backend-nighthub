import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../common/audit/audit-log.service';
import { VenuesService } from '../venues/venues.service';

function makePrismaMock() {
  return {
    organizations: {
      findUnique: jest.fn(),
    },
    events: {
      count: jest.fn(),
    },
    reservations: {
      aggregate: jest.fn(),
    },
  };
}

describe('OrganizationsService.getUsage', () => {
  let service: OrganizationsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: {} },
        { provide: VenuesService, useValue: {} },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  });

  it('throws NotFoundException when the organization does not exist', async () => {
    prisma.organizations.findUnique.mockResolvedValue(null);
    await expect(service.getUsage('missing')).rejects.toThrow(NotFoundException);
  });

  it('counts "clienti analizzati" as door-list guests (no-shows included), not real check-ins', async () => {
    prisma.organizations.findUnique.mockResolvedValue({
      id: 'org-1',
      plan: {
        id: 'plan-1',
        key: 'pulse',
        name: 'Pulse',
        icon: '🚀',
        monthly_price: 59,
        included_events: 2,
        included_people: 1000,
        extra_event_price: 5,
        extra_person_price: 0.02,
        is_custom: false,
      },
    });
    prisma.events.count.mockResolvedValue(3);
    // Matches the worked example: 500 + 400 + 800 = 1700, even though only some of them
    // actually walked in - the plan meters the list, not the door.
    prisma.reservations.aggregate.mockResolvedValue({ _sum: { guests: 1700 } });

    const result = await service.getUsage('org-1');

    expect(result.events_count).toBe(3);
    expect(result.people_count).toBe(1700);
    expect(result.included_events).toBe(2);
    expect(result.included_people).toBe(1000);
    expect(result.extra_events_count).toBe(1); // 3 - 2
    expect(result.extra_people_count).toBe(700); // 1700 - 1000
    expect(result.extra_events_cost).toBe(5); // 1 * 5
    expect(result.extra_people_cost).toBe(14); // 700 * 0.02
    expect(result.overage_cost).toBe(19);
  });

  it('scopes the reservations query to this organization\'s own events in the current period, excluding cancelled reservations', async () => {
    prisma.organizations.findUnique.mockResolvedValue({ id: 'org-1', plan: null });
    prisma.events.count.mockResolvedValue(0);
    prisma.reservations.aggregate.mockResolvedValue({ _sum: { guests: 0 } });

    await service.getUsage('org-1');

    expect(prisma.reservations.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: 'entry',
          status: { in: ['confirmed', 'completed'] },
          event: expect.objectContaining({
            organization_id: 'org-1',
            status: { not: 'CANCELLED' },
          }),
        }),
      }),
    );
  });

  it('returns zero usage and no plan when the organization has none assigned', async () => {
    prisma.organizations.findUnique.mockResolvedValue({ id: 'org-1', plan: null });
    prisma.events.count.mockResolvedValue(0);
    prisma.reservations.aggregate.mockResolvedValue({ _sum: { guests: null } });

    const result = await service.getUsage('org-1');

    expect(result.plan).toBeNull();
    expect(result.people_count).toBe(0);
    expect(result.included_events).toBeNull();
    expect(result.overage_cost).toBe(0);
  });
});
