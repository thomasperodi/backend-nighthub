import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../common/audit/audit-log.service';
import { VenuesService } from '../venues/venues.service';
import { billingMonth } from '../common/billing/plan-usage.util';

const PULSE = {
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
};

// org-1 is linked to venue-A (first link: billed to org-1) and venue-B (linked to org-2
// first: billed to org-2).
const ORG1_LINKS = [
  { venue: { id: 'venue-A', name: 'Paradise' } },
  { venue: { id: 'venue-B', name: 'Sottozero' } },
];
const FIRST_LINKS = [
  { venue_id: 'venue-B', organization_id: 'org-2' },
  { venue_id: 'venue-A', organization_id: 'org-1' },
  { venue_id: 'venue-B', organization_id: 'org-1' },
];

function makePrismaMock() {
  return {
    organizations: { findUnique: jest.fn() },
    organization_venue_links: {
      findMany: jest.fn((args: { where: { organization_id?: string } }) =>
        Promise.resolve(args.where.organization_id ? ORG1_LINKS : FIRST_LINKS),
      ),
      findFirst: jest.fn(),
    },
    events: { findMany: jest.fn().mockResolvedValue([]) },
    reservations: { groupBy: jest.fn().mockResolvedValue([]) },
    venues: { findUnique: jest.fn() },
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
    await expect(service.getUsage('missing')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('counts "clienti analizzati" as door-list guests (no-shows included) and prices the extras', async () => {
    prisma.organizations.findUnique.mockResolvedValue({
      id: 'org-1',
      plan: PULSE,
    });
    prisma.events.findMany.mockResolvedValue([
      { id: 'e1', venue_id: 'venue-A' },
      { id: 'e2', venue_id: 'venue-A' },
      { id: 'e3', venue_id: 'venue-C' }, // an org event at a venue billed elsewhere
    ]);
    // 500 + 400 + 800 = 1700 on the lists, whoever actually walked in.
    prisma.reservations.groupBy.mockResolvedValue([
      { event_id: 'e1', _sum: { guests: 500 } },
      { event_id: 'e2', _sum: { guests: 400 } },
      { event_id: 'e3', _sum: { guests: 800 } },
    ]);

    const result = await service.getUsage('org-1');

    expect(result.events_count).toBe(3);
    expect(result.people_count).toBe(1700);
    expect(result.extra_events_count).toBe(1); // 3 - 2
    expect(result.extra_people_count).toBe(700); // 1700 - 1000
    expect(result.extra_events_cost).toBe(5); // 1 * 5
    expect(result.extra_people_cost).toBe(14); // 700 * 0.02
    expect(result.overage_cost).toBe(19);
    expect(result.by_venue).toEqual([
      {
        venue_id: 'venue-A',
        venue_name: 'Paradise',
        events_count: 2,
        people_count: 900,
      },
    ]);
  });

  it("meters the organization's events plus the events created by the venues billed to it, never a venue billed to another organization", async () => {
    prisma.organizations.findUnique.mockResolvedValue({
      id: 'org-1',
      plan: null,
    });

    await service.getUsage('org-1');

    const { start, end } = billingMonth();
    expect(prisma.events.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { not: 'CANCELLED' },
          date: { gte: start, lt: end },
          OR: [
            { organization_id: 'org-1' },
            { organization_id: null, venue_id: { in: ['venue-A'] } },
          ],
        },
      }),
    );
  });

  it('returns zero usage and no plan when the organization has none assigned', async () => {
    prisma.organizations.findUnique.mockResolvedValue({
      id: 'org-1',
      plan: null,
    });

    const result = await service.getUsage('org-1');

    expect(result.plan).toBeNull();
    expect(result.people_count).toBe(0);
    expect(result.included_events).toBeNull();
    expect(result.overage_cost).toBe(0);
  });

  describe('getVenueBilling', () => {
    it("a linked venue sees its organization's plan, its own share and the extras", async () => {
      prisma.organization_venue_links.findFirst.mockResolvedValue({
        organization: { id: 'org-1', name: 'Night Crew' },
      });
      prisma.organizations.findUnique.mockResolvedValue({
        id: 'org-1',
        plan: PULSE,
      });
      prisma.events.findMany.mockResolvedValue([
        { id: 'e1', venue_id: 'venue-A' },
        { id: 'e2', venue_id: 'venue-A' },
        { id: 'e3', venue_id: 'venue-A' },
      ]);

      const billing = await service.getVenueBilling('venue-A');

      expect(billing).toEqual(
        expect.objectContaining({
          mode: 'organization',
          organization: { id: 'org-1', name: 'Night Crew' },
          venue_events_count: 3,
          events_count: 3,
          included_events: 2,
          extra_events_count: 1,
          overage_cost: 5,
        }),
      );
    });

    it('a venue without organization sees its flat contract', async () => {
      prisma.organization_venue_links.findFirst.mockResolvedValue(null);
      prisma.venues.findUnique.mockResolvedValue({
        contract_monthly_fee: '149.00',
        contract_status: 'active',
      });

      const billing = await service.getVenueBilling('venue-Z');

      expect(billing).toEqual(
        expect.objectContaining({
          mode: 'contract',
          monthly_fee: 149,
          contract_status: 'active',
        }),
      );
    });
  });
});

describe('billingMonth', () => {
  it('follows the Italian calendar, not the server clock', () => {
    // 30 Sep 22:30 UTC is already 1 Oct 00:30 in Italy.
    const { start, end } = billingMonth(new Date('2026-09-30T22:30:00Z'));
    expect(start).toEqual(new Date('2026-10-01T00:00:00Z'));
    expect(end).toEqual(new Date('2026-11-01T00:00:00Z'));
  });
});
