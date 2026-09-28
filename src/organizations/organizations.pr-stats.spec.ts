import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../common/audit/audit-log.service';
import { VenuesService } from '../venues/venues.service';

const ORG = 'org-1';
const user = (id: string, name: string) => ({
  id,
  name,
  username: name.toLowerCase(),
  email: `${id}@x.it`,
  avatar: null,
});

const memberships = [
  {
    id: 'resp',
    role: 'responsabile',
    parent_membership_id: null,
    is_active: true,
    ref_code: 'R',
    created_at: new Date(),
    user: user('u-resp', 'Marco'),
  },
  {
    id: 'pr-a',
    role: 'pr',
    parent_membership_id: 'resp',
    is_active: true,
    ref_code: 'A',
    created_at: new Date(),
    user: user('u-a', 'Sara'),
  },
  {
    id: 'pr-b',
    role: 'pr',
    parent_membership_id: 'resp',
    is_active: false,
    ref_code: 'B',
    created_at: new Date(),
    user: user('u-b', 'Elena'),
  },
];

const venueLinks = [
  {
    venue: { id: 'v1', name: 'NOX Milano', city: 'Milano' },
    created_at: new Date('2025-03-12'),
  },
  {
    venue: { id: 'v2', name: 'NOX Roma', city: 'Roma' },
    created_at: new Date('2025-06-03'),
  },
];

function makePrisma() {
  return {
    venue_pr_memberships: {
      findMany: jest.fn().mockResolvedValue(memberships),
    },
    organization_venue_links: {
      findMany: jest.fn().mockResolvedValue(venueLinks),
      findUnique: jest.fn(),
    },
    events: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    venue_stays: { groupBy: jest.fn().mockResolvedValue([]) },
    venue_pr_event_assignments: {
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockReturnValue('upsert-op'),
      updateMany: jest.fn().mockReturnValue('update-op'),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };
}

describe('OrganizationsService PR stats & assignments', () => {
  let service: OrganizationsService;
  let prisma: ReturnType<typeof makePrisma>;
  let venues: { queryPrCounters: jest.Mock };

  beforeEach(async () => {
    prisma = makePrisma();
    venues = {
      queryPrCounters: jest.fn().mockResolvedValue([
        {
          pr_membership_id: 'resp',
          bucket: 'v1',
          referral_reservations: 1,
          referral_guests: 2,
          attributed_entries: 2,
          scans: 1,
        },
        {
          pr_membership_id: 'pr-a',
          bucket: 'v1',
          referral_reservations: 3,
          referral_guests: 6,
          attributed_entries: 4,
          scans: 0,
        },
        {
          pr_membership_id: 'pr-a',
          bucket: 'v2',
          referral_reservations: 2,
          referral_guests: 2,
          attributed_entries: 2,
          scans: 2,
        },
      ]),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrganizationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditLogService, useValue: {} },
        { provide: VenuesService, useValue: venues },
      ],
    }).compile();
    service = module.get(OrganizationsService);
  });

  describe('1.4 getStats', () => {
    it('returns the official metrics as totals, per venue and per member (with team_*)', async () => {
      const stats = await service.getStats(ORG);

      expect(stats.referral_reservations).toBe(6);
      expect(stats.referral_guests).toBe(10);
      expect(stats.attributed_entries).toBe(8);
      expect(stats.conversion_rate).toBeCloseTo(0.8, 3);
      expect(stats.scans).toBe(3);
      expect(stats.active_pr_count).toBe(2);
      expect(stats.total_pr_count).toBe(3);

      const v1 = stats.by_venue.find((v) => v.venue.id === 'v1')!;
      const v2 = stats.by_venue.find((v) => v.venue.id === 'v2')!;
      expect(v1.attributed_entries).toBe(6);
      expect(v2.attributed_entries).toBe(2);
      // No more copy-pasted network-wide count on every venue row.
      expect(v1).not.toHaveProperty('active_pr_count');

      const resp = stats.by_member.find((m) => m.membership_id === 'resp')!;
      expect(resp.attributed_entries).toBe(2);
      expect(resp.team_attributed_entries).toBe(8); // 2 own + 6 of Sara
      expect(resp.team_referral_reservations).toBe(6);
    });

    it('passes venue and date filters down to one aggregate query', async () => {
      const from = new Date('2026-09-01');
      const to = new Date('2026-10-01');
      prisma.organization_venue_links.findMany.mockResolvedValue([
        venueLinks[0],
      ]);

      await service.getStats(ORG, { venue_id: 'v1', from, to });

      expect(venues.queryPrCounters).toHaveBeenCalledTimes(1);
      expect(venues.queryPrCounters).toHaveBeenCalledWith(
        expect.objectContaining({
          venueIds: ['v1'],
          from,
          to,
          bucket: 'venue',
          membershipIds: ['resp', 'pr-a', 'pr-b'],
        }),
      );
    });

    it('shows the venue only the aggregate, never the individual PRs', async () => {
      prisma.organization_venue_links.findUnique.mockResolvedValue({
        id: 'link',
      });
      prisma.organization_venue_links.findMany.mockResolvedValue([
        venueLinks[0],
      ]);

      const stats = await service.getStatsForVenue('v1', ORG);

      expect(stats).not.toHaveProperty('by_member');
      expect(stats).not.toHaveProperty('by_venue');
      expect(stats.attributed_entries).toBeGreaterThan(0);
    });
  });

  describe('listPrNetwork with stats', () => {
    it('resolves the parent and attaches own/team metrics without N+1', async () => {
      const rows = await service.listPrNetwork(ORG, { includeStats: true });

      expect(venues.queryPrCounters).toHaveBeenCalledTimes(1);
      const sara = rows.find((r) => r.id === 'pr-a')!;
      expect(sara.parent).toEqual({ id: 'resp', display_name: 'Marco' });
      expect(sara.stats?.attributed_entries).toBe(6);
      expect(rows.find((r) => r.id === 'resp')!.team_count).toBe(2);
    });
  });

  describe('event PR assignments', () => {
    it("answers 404 for another organization's event (cross-tenant)", async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'e1',
        organization_id: 'org-2',
        venue_id: 'v1',
      });

      await expect(service.listEventPrAssignments(ORG, 'e1')).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        service.setEventPrAssignments(
          ORG,
          'e1',
          { all_active: true },
          undefined,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it("lets the organization assign its PRs to the venue's own events at a linked venue", async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'e2',
        organization_id: null,
        venue_id: 'v1',
      });
      prisma.organization_venue_links.findUnique.mockResolvedValue({
        id: 'link',
      });

      const rows = await service.listEventPrAssignments(ORG, 'e2');

      expect(rows.map((r) => r.membership_id)).toEqual([
        'resp',
        'pr-a',
        'pr-b',
      ]);
    });

    it('answers 404 for a venue event at a venue the organization is not linked to', async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'e3',
        organization_id: null,
        venue_id: 'v9',
      });
      prisma.organization_venue_links.findUnique.mockResolvedValue(null);

      await expect(service.listEventPrAssignments(ORG, 'e3')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('assigns every active PR with all_active and deactivates the rest (never deletes)', async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'e1',
        organization_id: ORG,
        venue_id: 'v1',
      });

      await service.setEventPrAssignments(ORG, 'e1', { all_active: true }, {
        id: 'owner',
      } as never);

      const upsertCalls = prisma.venue_pr_event_assignments.upsert.mock
        .calls as Array<
        [{ create: { pr_membership_id: string; venue_id: string } }]
      >;
      const upserted = upsertCalls.map(([arg]) => arg.create.pr_membership_id);
      expect(upserted.sort()).toEqual(['pr-a', 'resp']);
      expect(upsertCalls[0][0].create.venue_id).toBe('v1');
      expect(prisma.venue_pr_event_assignments.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            pr_membership_id: { in: ['pr-b'] },
          }) as unknown,
          data: { is_active: false },
        }),
      );
    });

    it('refuses to assign a deactivated PR or one outside the organization', async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'e1',
        organization_id: ORG,
        venue_id: 'v1',
      });

      await expect(
        service.setEventPrAssignments(
          ORG,
          'e1',
          { membership_ids: ['pr-b'] },
          undefined,
        ),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.setEventPrAssignments(
          ORG,
          'e1',
          { membership_ids: ['someone-else'] },
          undefined,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });
});
