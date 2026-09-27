import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrNetworkService, currentNightDate } from './pr-network.service';
import type { RequestUser } from '../auth/types';

const VENUE = 'venue-1';
const row = (
  id: string,
  parent: string | null,
  extra: Record<string, unknown> = {},
) => ({
  id,
  venue_id: null,
  user_id: `user-${id}`,
  role: parent ? 'pr' : 'responsabile',
  parent_membership_id: parent,
  ref_code: id.toUpperCase(),
  is_active: true,
  created_at: new Date(),
  updated_at: new Date(),
  organization_id: 'org-1',
  user_name: id,
  user_username: id,
  user_email: `${id}@x.it`,
  user_avatar: null,
  ...extra,
});

const resp = row('resp', null);
const prA = row('pr-a', 'resp');
const otherResp = row('other', null);
const prX = row('pr-x', 'other');
const tree = [resp, prA, otherResp, prX];

function collectSubtree(
  rootId: string,
  rows: Array<{ id: string; parent_membership_id: string | null }>,
) {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (
        r.parent_membership_id &&
        out.has(r.parent_membership_id) &&
        !out.has(r.id)
      ) {
        out.add(r.id);
        grew = true;
      }
    }
  }
  return out;
}

function makeVenues() {
  return {
    getVenueAndPrActorContext: jest.fn(),
    resolveScannablePrMembership: jest.fn(),
    loadPrHierarchyRowsForActor: jest.fn().mockResolvedValue(tree),
    collectPrSubtree: jest.fn(collectSubtree),
    normalizeAppRole: jest.fn((role: string) => role),
    queryPrCounters: jest.fn().mockResolvedValue([]),
    listMyPrVenueMemberships: jest.fn(),
    loadPrMembershipByIdGlobal: jest.fn(),
    loadPrMembershipByUser: jest.fn(),
    lookupUserForPrInvite: jest.fn(),
    createOrganizationPrMember: jest.fn(),
    createVenuePrNetworkMember: jest.fn(),
    loadPrMemberRowByIdGlobal: jest.fn(),
    mapPrMember: jest.fn(),
    toPrRoleApi: jest.fn((r: string) => r.toUpperCase()),
    toIsoString: jest.fn((d: Date) => d.toISOString()),
  };
}

function makePrisma() {
  return {
    events: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'event-1',
        name: 'Sabato',
        date: new Date(),
        status: 'LIVE',
        venue_id: VENUE,
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    venue_pr_memberships: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    venue_pr_event_assignments: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

const client = (id: string) =>
  ({ id, role: 'client' }) as unknown as RequestUser;

describe('PrNetworkService', () => {
  let venues: ReturnType<typeof makeVenues>;
  let prisma: ReturnType<typeof makePrisma>;
  let service: PrNetworkService;

  beforeEach(() => {
    venues = makeVenues();
    prisma = makePrisma();

    service = new PrNetworkService(prisma as any, venues as any);
  });

  describe('GET /venues/:id/pr-dashboard/guests', () => {
    it("lets a PR read only its own guests, never another PR's", async () => {
      venues.getVenueAndPrActorContext.mockResolvedValue({
        owner: false,
        membership: prA,
      });

      await expect(
        service.listDashboardGuests(VENUE, client('user-pr-a'), {
          eventId: 'event-1',
          membershipId: 'resp',
        }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.listDashboardGuests(VENUE, client('user-pr-a'), {
          eventId: 'event-1',
          membershipId: 'pr-x',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets a responsabile read its whole team with scope=team, and exposes no contact data', async () => {
      venues.getVenueAndPrActorContext.mockResolvedValue({
        owner: false,
        membership: resp,
      });
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'r1',
          type: 'entry',
          status: 'confirmed',
          guests: 3,
          actual_guests: 2,
          checked_in_at: new Date(),
          created_at: new Date(),
          pr_membership_id: 'pr-a',
          user_id: 'g1',
          user_name: 'Giulia',
          user_username: 'giulia',
          user_avatar: null,
          guest_name: null,
          guest_surname: null,
        },
        {
          id: 'r2',
          type: 'entry',
          status: 'confirmed',
          guests: 1,
          actual_guests: null,
          checked_in_at: null,
          created_at: new Date(),
          pr_membership_id: 'resp',
          user_id: null,
          user_name: null,
          user_username: null,
          user_avatar: null,
          guest_name: 'Luca',
          guest_surname: 'Bianchi',
        },
      ]);
      prisma.venue_pr_memberships.findMany.mockResolvedValue([
        { id: 'pr-a', user: { name: 'Sara', username: 'sara' } },
      ]);

      const result = await service.listDashboardGuests(
        VENUE,
        client('user-resp'),
        { eventId: 'event-1', scope: 'team' },
      );

      expect(result.counters).toEqual({
        reservations: 2,
        guests: 4,
        entered: 2,
        expected: 2,
        cancelled: 0,
      });
      expect(result.guests[0].pr_display_name).toBe('Sara');
      expect(result.guests[1].user.name).toBe('Luca B.');
      expect(JSON.stringify(result)).not.toMatch(/@x\.it|email|phone/);
    });

    it("hides an organization PR's guests from the venue (404)", async () => {
      venues.getVenueAndPrActorContext.mockResolvedValue({
        owner: true,
        membership: null,
      });
      venues.resolveScannablePrMembership.mockResolvedValue(prA);

      await expect(
        service.listDashboardGuests(
          VENUE,
          { id: 'v', role: 'venue' } as unknown as RequestUser,
          {
            eventId: 'event-1',
            membershipId: 'pr-a',
          },
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects an event of another venue', async () => {
      prisma.events.findUnique.mockResolvedValue({
        id: 'event-9',
        venue_id: 'venue-9',
        date: new Date(),
        status: 'LIVE',
      });
      venues.getVenueAndPrActorContext.mockResolvedValue({
        owner: false,
        membership: prA,
      });

      await expect(
        service.listDashboardGuests(VENUE, client('user-pr-a'), {
          eventId: 'event-9',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('/pr-network/me/team', () => {
    it('is only for an active responsabile', async () => {
      prisma.venue_pr_memberships.findMany.mockResolvedValue([]);

      await expect(service.listMyTeam(client('user-pr-a'))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('adds an organization PR as an organization row under the caller', async () => {
      prisma.venue_pr_memberships.findMany.mockResolvedValue([{ id: 'resp' }]);
      venues.loadPrMembershipByIdGlobal.mockResolvedValue(resp);
      venues.createOrganizationPrMember.mockResolvedValue({
        id: 'new',
        user: { email: 'n@x.it' },
      });

      const created = await service.addToMyTeam(client('user-resp'), {
        user_id: 'new-user',
      });

      expect(venues.createOrganizationPrMember).toHaveBeenCalledWith('org-1', {
        user_id: 'new-user',
        role: 'pr',
        parent_membership_id: 'resp',
        created_by_user_id: 'user-resp',
      });
      expect(venues.createVenuePrNetworkMember).not.toHaveBeenCalled();
      expect(created.user.email).toBeNull();
    });

    it('adds a venue PR as a venue row under the caller', async () => {
      const venueResp = row('vresp', null, {
        venue_id: VENUE,
        organization_id: null,
      });
      prisma.venue_pr_memberships.findMany.mockResolvedValue([{ id: 'vresp' }]);
      venues.loadPrMembershipByIdGlobal.mockResolvedValue(venueResp);
      venues.createVenuePrNetworkMember.mockResolvedValue({
        id: 'new',
        user: { email: 'n@x.it' },
      });

      await service.addToMyTeam(client('user-vresp'), { user_id: 'new-user' });

      expect(venues.createVenuePrNetworkMember).toHaveBeenCalledWith(
        VENUE,
        { user_id: 'new-user', role: 'pr', parent_membership_id: 'vresp' },
        expect.anything(),
      );
    });

    it('refuses to toggle a PR outside the caller subtree', async () => {
      prisma.venue_pr_memberships.findMany.mockResolvedValue([{ id: 'resp' }]);
      venues.loadPrMembershipByIdGlobal.mockResolvedValue(resp);

      await expect(
        service.updateMyTeamMember(client('user-resp'), 'pr-x', {
          is_active: false,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.venue_pr_memberships.update).not.toHaveBeenCalled();
    });

    it('asks which team when the caller leads more than one', async () => {
      prisma.venue_pr_memberships.findMany.mockResolvedValue([
        { id: 'a' },
        { id: 'b' },
      ]);

      await expect(service.listMyTeam(client('u'))).rejects.toThrow(
        BadRequestException,
      );
    });

    it('lookup never returns the email', async () => {
      prisma.venue_pr_memberships.findMany
        .mockResolvedValueOnce([{ id: 'resp' }])
        .mockResolvedValueOnce([]);
      venues.loadPrMembershipByIdGlobal.mockResolvedValue(resp);
      venues.lookupUserForPrInvite.mockResolvedValue({
        id: 'u9',
        name: 'Nuovo',
        username: 'nuovo',
        email: 'n@x.it',
        avatar: null,
      });

      const found = await service.lookupForMyTeam(client('user-resp'), 'nuovo');

      expect(found).toEqual({
        id: 'u9',
        name: 'Nuovo',
        username: 'nuovo',
        avatar: null,
        status: 'available',
      });
    });
  });

  describe('currentNightDate', () => {
    it('keeps the previous calendar day until the early-morning rollover', () => {
      const early = currentNightDate(new Date(2026, 8, 27, 2, 0));
      const evening = currentNightDate(new Date(2026, 8, 27, 22, 0));
      expect(early.getTime()).toBe(Date.UTC(2026, 8, 26));
      expect(evening.getTime()).toBe(Date.UTC(2026, 8, 27));
    });
  });
});
