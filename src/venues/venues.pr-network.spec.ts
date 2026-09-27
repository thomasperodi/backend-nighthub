import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { VenuesService } from './venues.service';
import type { RequestUser } from '../auth/types';

// Unit tests for the PR-network fixes (Organization & PR rework, Fase 1). VenuesService is
// built on raw SQL, so these tests stub its loaders/actor helpers instead of the SQL itself:
// what's under test is the authorization and hierarchy logic around them.

const VENUE = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const RESP = '33333333-3333-4333-8333-333333333333';
const CHILD = '44444444-4444-4444-8444-444444444444';
const VENUE_PR = '55555555-5555-4555-8555-555555555555';

function membership(overrides: Record<string, unknown> = {}) {
  return {
    id: RESP,
    venue_id: null,
    user_id: 'user-resp',
    role: 'responsabile',
    parent_membership_id: null,
    ref_code: 'RESP-AAAAAA',
    is_active: true,
    created_by_user_id: null,
    created_at: new Date('2026-09-01T00:00:00Z'),
    updated_at: new Date('2026-09-01T00:00:00Z'),
    organization_id: ORG,
    user_name: 'Marco',
    user_username: 'marco',
    user_email: 'marco@x.it',
    user_role: 'client',
    user_avatar: null,
    organization_name: 'NOX',
    ...overrides,
  };
}

const orgResp = membership();
const orgChild = membership({
  id: CHILD,
  user_id: 'user-child',
  role: 'pr',
  parent_membership_id: RESP,
  ref_code: 'SARA-BBBBBB',
  user_name: 'Sara',
  user_username: 'sara',
  user_email: 'sara@x.it',
});
const venuePr = membership({
  id: VENUE_PR,
  venue_id: VENUE,
  organization_id: null,
  organization_name: null,
  user_id: 'user-venue',
  role: 'responsabile',
  ref_code: 'LUCA-CCCCCC',
  user_name: 'Luca',
});

function makePrisma() {
  return {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(1),
    venue_pr_memberships: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
    venue_pr_qr_scans: { count: jest.fn().mockResolvedValue(0) },
    entries: { count: jest.fn().mockResolvedValue(0) },
    venue_pr_membership_pass_scans: { count: jest.fn().mockResolvedValue(0) },
    organizations: {
      findUnique: jest.fn().mockResolvedValue({ id: ORG, is_active: true }),
    },
    users: { findUnique: jest.fn() },
    organization_venue_links: { findUnique: jest.fn() },
  };
}

type Prisma = ReturnType<typeof makePrisma>;
type AnyService = VenuesService & Record<string, jest.Mock>;

function makeService(prisma: Prisma) {
  return new VenuesService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
  ) as AnyService;
}

const prUser = (id: string): RequestUser =>
  ({ id, role: 'client' }) as unknown as RequestUser;
const venueUser = {
  id: 'venue-owner',
  role: 'venue',
  venue_id: VENUE,
} as unknown as RequestUser;

describe('VenuesService PR network (Organization & PR rework)', () => {
  let prisma: Prisma;
  let service: AnyService;

  beforeEach(() => {
    prisma = makePrisma();
    service = makeService(prisma);
  });

  describe('1.1 getPrDashboardStats', () => {
    it('shows an organization responsabile its own team (org rows have venue_id NULL)', async () => {
      jest
        .spyOn(service, 'getVenueAndPrActorContext')
        .mockResolvedValue({ owner: false, membership: orgResp as never });
      const union = jest
        .spyOn(service, 'loadPrMemberRowsForVenue')
        .mockResolvedValue([orgResp, orgChild, venuePr] as never);
      jest.spyOn(service, 'queryPrCounters').mockResolvedValue([
        {
          pr_membership_id: RESP,
          bucket: '',
          referral_reservations: 2,
          referral_guests: 4,
          attributed_entries: 3,
          scans: 1,
        },
        {
          pr_membership_id: CHILD,
          bucket: '',
          referral_reservations: 5,
          referral_guests: 10,
          attributed_entries: 8,
          scans: 0,
        },
        {
          pr_membership_id: VENUE_PR,
          bucket: '',
          referral_reservations: 9,
          referral_guests: 9,
          attributed_entries: 9,
          scans: 9,
        },
      ]);

      const result = await service.getPrDashboardStats(
        VENUE,
        prUser('user-resp'),
      );

      expect(union).toHaveBeenCalledWith(VENUE);
      expect(result.members.map((m) => m.id).sort()).toEqual(
        [RESP, CHILD].sort(),
      );
      const resp = result.members.find((m) => m.id === RESP)!;
      expect(resp.stats.attributed_entries).toBe(3);
      expect(resp.team_stats.attributed_entries).toBe(11); // 3 own + 8 child
      expect(resp.team_stats.referral_guests).toBe(14);
      expect(resp.team_stats.conversion_rate).toBeCloseTo(11 / 14, 3);
      // Totals = everything the responsabile can see (own + team), never the venue's own PR.
      expect(result.totals.referral_reservations).toBe(7);
      expect(result.totals.entries).toBe(result.totals.attributed_entries); // legacy alias
      // PR-to-PR views never carry contact data.
      expect(resp.user.email).toBeNull();
    });

    it('never shows organization PRs to the venue account (exclusivity)', async () => {
      jest
        .spyOn(service, 'getVenueAndPrActorContext')
        .mockResolvedValue({ owner: true, membership: null });
      jest
        .spyOn(service, 'loadPrMemberRowsForVenue')
        .mockResolvedValue([orgResp, orgChild, venuePr] as never);
      jest.spyOn(service, 'queryPrCounters').mockResolvedValue([]);

      const result = await service.getPrDashboardStats(VENUE, venueUser);

      expect(result.members.map((m) => m.id)).toEqual([VENUE_PR]);
    });

    it('keeps team_stats correct when narrowed to one membership', async () => {
      jest
        .spyOn(service, 'getVenueAndPrActorContext')
        .mockResolvedValue({ owner: false, membership: orgResp as never });
      jest
        .spyOn(service, 'loadPrMemberRowsForVenue')
        .mockResolvedValue([orgResp, orgChild] as never);
      jest
        .spyOn(service, 'queryPrCounters')
        .mockResolvedValue([
          { pr_membership_id: CHILD, bucket: '', attributed_entries: 4 },
        ]);

      const result = await service.getPrDashboardStats(
        VENUE,
        prUser('user-resp'),
        {
          membership_id: RESP,
        },
      );

      expect(result.members).toHaveLength(1);
      expect(result.members[0].team_stats.attributed_entries).toBe(4);
    });

    it('rejects a membership outside the caller subtree', async () => {
      jest
        .spyOn(service, 'getVenueAndPrActorContext')
        .mockResolvedValue({ owner: false, membership: orgChild as never });
      jest
        .spyOn(service, 'loadPrMemberRowsForVenue')
        .mockResolvedValue([orgResp, orgChild] as never);
      jest.spyOn(service, 'queryPrCounters').mockResolvedValue([]);

      await expect(
        service.getPrDashboardStats(VENUE, prUser('user-child'), {
          membership_id: RESP,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('1.2 assignPrMemberToEvent', () => {
    beforeEach(() => {
      jest.spyOn(service, 'getVenue').mockResolvedValue({ id: VENUE } as never);
      jest
        .spyOn(service as never, 'ensureEventBelongsToVenue')
        .mockResolvedValue(undefined as never);
      prisma.$queryRaw.mockResolvedValue([
        {
          id: 'assign-1',
          venue_id: VENUE,
          event_id: 'event-1',
          pr_membership_id: CHILD,
          is_active: true,
          assigned_by_user_id: null,
          created_at: new Date(),
          updated_at: new Date(),
          role: 'pr',
          ref_code: 'SARA-BBBBBB',
          parent_membership_id: RESP,
          user_name: 'Sara',
          user_username: 'sara',
          user_email: 'sara@x.it',
        },
      ]);
    });

    it('assigns an organization PR (resolved through the org-venue link, not venue_id)', async () => {
      jest
        .spyOn(service, 'resolvePrActorContext')
        .mockResolvedValue({ owner: false, membership: orgResp as never });
      const resolve = jest
        .spyOn(service, 'resolveScannablePrMembership')
        .mockResolvedValue(orgChild as never);
      const tree = jest
        .spyOn(service, 'loadPrHierarchyRowsForActor')
        .mockResolvedValue([orgResp, orgChild] as never);

      const result = await service.assignPrMemberToEvent(
        VENUE,
        { event_id: 'event-1', pr_membership_id: CHILD },
        prUser('user-resp'),
      );

      expect(resolve).toHaveBeenCalledWith(VENUE, { id: CHILD });
      expect(tree).toHaveBeenCalledWith(VENUE, orgResp);
      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(result.pr_membership_id).toBe(CHILD);
    });

    it('answers 404 to the venue for an organization PR', async () => {
      jest
        .spyOn(service, 'resolvePrActorContext')
        .mockResolvedValue({ owner: true, membership: null });
      jest
        .spyOn(service, 'resolveScannablePrMembership')
        .mockResolvedValue(orgChild as never);

      await expect(
        service.assignPrMemberToEvent(
          VENUE,
          { event_id: 'event-1', pr_membership_id: CHILD },
          venueUser,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('forbids a responsabile from assigning a PR outside its subtree', async () => {
      const otherResp = membership({ id: 'other', parent_membership_id: null });
      jest
        .spyOn(service, 'resolvePrActorContext')
        .mockResolvedValue({ owner: false, membership: otherResp as never });
      jest
        .spyOn(service, 'resolveScannablePrMembership')
        .mockResolvedValue(orgChild as never);
      jest
        .spyOn(service, 'loadPrHierarchyRowsForActor')
        .mockResolvedValue([orgResp, orgChild, otherResp] as never);

      await expect(
        service.assignPrMemberToEvent(
          VENUE,
          { event_id: 'event-1', pr_membership_id: CHILD },
          prUser('x'),
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('1.5 createOrganizationPrMember', () => {
    beforeEach(() => {
      prisma.users.findUnique.mockResolvedValue({
        id: 'new-user',
        email: 'n@x.it',
        username: 'nuovo',
        name: 'Nuovo',
      });
    });

    it('refuses a user already active in another organization (409)', async () => {
      prisma.venue_pr_memberships.findMany.mockResolvedValue([
        { id: 'm-other', organization_id: 'other-org', is_active: true },
      ]);

      const err = await service
        .createOrganizationPrMember(ORG, {
          user_id: 'new-user',
          role: 'responsabile',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'OTHER_ORGANIZATION',
      });
    });

    it('explains in Italian that a PR needs a responsabile', async () => {
      prisma.venue_pr_memberships.findMany.mockResolvedValue([]);

      await expect(
        service.createOrganizationPrMember(ORG, {
          user_id: 'new-user',
          role: 'pr',
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'Un PR deve stare sotto un responsabile: sceglilo prima di salvare',
        ),
      );
    });

    it('refuses a parent from another organization', async () => {
      prisma.venue_pr_memberships.findMany.mockResolvedValue([]);
      jest
        .spyOn(service, 'loadPrMembershipByIdGlobal')
        .mockResolvedValue(
          membership({ organization_id: 'other-org' }) as never,
        );

      await expect(
        service.createOrganizationPrMember(ORG, {
          user_id: 'new-user',
          role: 'pr',
          parent_membership_id: RESP,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('1.6 role change and removal never break the tree or wipe history', () => {
    it('blocks responsabile → pr while it still has PRs under it (409)', async () => {
      jest
        .spyOn(service, 'loadPrMembershipByIdGlobal')
        .mockResolvedValue(orgResp as never);
      prisma.venue_pr_memberships.count.mockResolvedValue(2);

      const err = await service
        .updateOrganizationPrMember(ORG, RESP, {
          role: 'pr',
          parent_membership_id: 'x',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).message).toBe(
        'Sposta prima i suoi 2 PR sotto un altro responsabile',
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses to delete an organization PR with history (409 HAS_HISTORY)', async () => {
      jest
        .spyOn(service, 'loadPrMembershipByIdGlobal')
        .mockResolvedValue(orgChild as never);
      prisma.venue_pr_memberships.count.mockResolvedValue(0);
      prisma.entries.count.mockResolvedValue(3);
      prisma.$queryRaw.mockResolvedValue([{ count: 0 }]);

      const err = await service
        .deleteOrganizationPrMember(ORG, CHILD)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'HAS_HISTORY',
      });
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses to delete a responsabile that still has a team (409 HAS_TEAM)', async () => {
      jest
        .spyOn(service, 'loadPrMembershipByIdGlobal')
        .mockResolvedValue(orgResp as never);
      prisma.venue_pr_memberships.count.mockResolvedValue(1);

      const err = await service
        .deleteOrganizationPrMember(ORG, RESP)
        .catch((e: unknown) => e);

      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'HAS_TEAM',
      });
    });

    it('deletes a membership with no history at all', async () => {
      jest
        .spyOn(service, 'loadPrMembershipByIdGlobal')
        .mockResolvedValue(orgChild as never);
      prisma.$queryRaw.mockResolvedValue([{ count: 0 }]);

      await expect(
        service.deleteOrganizationPrMember(ORG, CHILD),
      ).resolves.toEqual({ deleted: true, id: CHILD });
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('applies the same history guard to venue PRs', async () => {
      jest.spyOn(service, 'getVenue').mockResolvedValue({ id: VENUE } as never);
      prisma.$queryRaw
        .mockResolvedValueOnce([venuePr])
        .mockResolvedValue([{ count: 1 }]);
      jest
        .spyOn(service, 'resolvePrActorContext')
        .mockResolvedValue({ owner: true, membership: null });

      const err = await service
        .deleteVenuePrNetworkMember(VENUE, VENUE_PR, venueUser)
        .catch((e: unknown) => e);

      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'HAS_HISTORY',
      });
    });

    it('never lets an organization touch another organization PR', async () => {
      jest
        .spyOn(service, 'loadPrMembershipByIdGlobal')
        .mockResolvedValue(
          membership({ organization_id: 'other-org' }) as never,
        );

      await expect(
        service.updateOrganizationPrMember(ORG, RESP, { is_active: false }),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
