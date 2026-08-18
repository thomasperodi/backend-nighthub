import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../common/audit/audit-log.service';
import type { RequestUser } from '../auth/types';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  // Centralizes the ownership check other modules were flagged (in the NightHub audit) for
  // re-implementing ad hoc per-endpoint - every organization-scoped method in this service
  // goes through this single place instead of repeating an if/throw. Admin always passes;
  // an `organization`-role account only passes for its own organization_id (confirmed
  // business rule: one owner account per organization, no shared membership table).
  private assertOrgAccess(
    actor: RequestUser | undefined,
    organizationId: string,
  ) {
    if (!actor?.id) throw new ForbiddenException('Forbidden');
    const role = String(actor.role || '').toLowerCase();
    if (role === 'admin') return;
    if (role === 'organization' && actor.organization_id === organizationId)
      return;
    throw new ForbiddenException('Forbidden');
  }

  private assertAdmin(actor: RequestUser | undefined) {
    if (String(actor?.role || '').toLowerCase() !== 'admin') {
      throw new ForbiddenException('Forbidden');
    }
  }

  async create(dto: CreateOrganizationDto, actor: RequestUser | undefined) {
    this.assertAdmin(actor);
    const organization = await this.prisma.organizations.create({
      data: {
        name: dto.name.trim(),
        vat_number: dto.vat_number?.trim() || null,
      },
    });
    if (actor?.id) {
      this.auditLog.record({
        adminId: actor.id,
        action: 'organization.create',
        targetType: 'organization',
        targetId: organization.id,
        metadata: { name: organization.name },
      });
    }
    return organization;
  }

  async list(actor: RequestUser | undefined) {
    this.assertAdmin(actor);
    return this.prisma.organizations.findMany({
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { venue_links: true, pr_memberships: true } },
      },
    });
  }

  async getById(organizationId: string, actor: RequestUser | undefined) {
    this.assertOrgAccess(actor, organizationId);
    const organization = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
      include: {
        venue_links: {
          include: { venue: { select: { id: true, name: true, city: true } } },
        },
      },
    });
    if (!organization) throw new NotFoundException('Organization not found');
    return organization;
  }

  /** GET /organizations/me — resolves the caller's own organization from their session. */
  async getMine(actor: RequestUser | undefined) {
    if (!actor?.organization_id) {
      throw new NotFoundException(
        'No organization associated with this account',
      );
    }
    return this.getById(actor.organization_id, actor);
  }

  async update(
    organizationId: string,
    dto: UpdateOrganizationDto,
    actor: RequestUser | undefined,
  ) {
    this.assertAdmin(actor);
    const existing = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Organization not found');

    const organization = await this.prisma.organizations.update({
      where: { id: organizationId },
      data: {
        name: dto.name?.trim(),
        vat_number:
          dto.vat_number === undefined
            ? undefined
            : dto.vat_number?.trim() || null,
        is_active: dto.is_active,
      },
    });

    if (actor?.id) {
      this.auditLog.record({
        adminId: actor.id,
        action: 'organization.update',
        targetType: 'organization',
        targetId: organizationId,
        metadata: dto as Record<string, unknown>,
      });
    }

    return organization;
  }

  // Deliberately admin-only, not a bilateral request/accept flow - see the confirmed
  // business rule in the Organizations audit doc: the platform admin does every
  // organization<->venue pairing manually, so this needs to stay fast for them to use, not
  // require a round trip through either side accepting.
  async linkVenue(
    organizationId: string,
    venueId: string,
    actor: RequestUser | undefined,
  ) {
    this.assertAdmin(actor);

    const [organization, venue] = await Promise.all([
      this.prisma.organizations.findUnique({
        where: { id: organizationId },
        select: { id: true },
      }),
      this.prisma.venues.findUnique({
        where: { id: venueId },
        select: { id: true },
      }),
    ]);
    if (!organization) throw new NotFoundException('Organization not found');
    if (!venue) throw new NotFoundException('Venue not found');

    const existing = await this.prisma.organization_venue_links.findUnique({
      where: {
        organization_id_venue_id: {
          organization_id: organizationId,
          venue_id: venueId,
        },
      },
    });
    if (existing) throw new BadRequestException('Already linked');

    const link = await this.prisma.organization_venue_links.create({
      data: {
        organization_id: organizationId,
        venue_id: venueId,
        created_by_admin_id: actor?.id,
      },
      include: { venue: { select: { id: true, name: true, city: true } } },
    });

    if (actor?.id) {
      this.auditLog.record({
        adminId: actor.id,
        action: 'organization.link_venue',
        targetType: 'organization',
        targetId: organizationId,
        metadata: { venue_id: venueId },
      });
    }

    return link;
  }

  // Unlinking cascades to deactivating (never deleting - confirmed business rule) any PR
  // memberships this organization held at that venue: a PR is scoped through the venue link,
  // so losing the link means losing that venue too, for now (see venue_pr_memberships.
  // organization_id's doc comment).
  async unlinkVenue(
    organizationId: string,
    venueId: string,
    actor: RequestUser | undefined,
  ) {
    this.assertAdmin(actor);

    const link = await this.prisma.organization_venue_links.findUnique({
      where: {
        organization_id_venue_id: {
          organization_id: organizationId,
          venue_id: venueId,
        },
      },
    });
    if (!link) throw new NotFoundException('Link not found');

    await this.prisma.$transaction([
      this.prisma.organization_venue_links.delete({ where: { id: link.id } }),
      this.prisma.venue_pr_memberships.updateMany({
        where: {
          organization_id: organizationId,
          venue_id: venueId,
          is_active: true,
        },
        data: { is_active: false },
      }),
    ]);

    if (actor?.id) {
      this.auditLog.record({
        adminId: actor.id,
        action: 'organization.unlink_venue',
        targetType: 'organization',
        targetId: organizationId,
        metadata: { venue_id: venueId },
      });
    }

    return { success: true };
  }

  /** Venues linked to an organization — org-self or admin. */
  async listVenues(organizationId: string, actor: RequestUser | undefined) {
    this.assertOrgAccess(actor, organizationId);
    return this.prisma.organization_venue_links.findMany({
      where: { organization_id: organizationId },
      include: {
        venue: { select: { id: true, name: true, city: true, image: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /** Organizations linked to a venue — venue-self (of that venue) or admin. Used by the
   * venue-side "which organizations work here" view and the PR-network invite form. */
  async listForVenue(venueId: string, actor: RequestUser | undefined) {
    const role = String(actor?.role || '').toLowerCase();
    if (role !== 'admin') {
      if (role !== 'venue' || actor?.venue_id !== venueId) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.prisma.organization_venue_links.findMany({
      where: { venue_id: venueId },
      include: {
        organization: { select: { id: true, name: true, is_active: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /** PR members working for this organization, across every venue it's linked to — org-self
   * or admin. This is the org-side counterpart to VenuesService.listVenuePrNetworkMembers,
   * which is scoped to one venue; this one intentionally spans all of them (confirmed
   * business rule: the organization sees its own PRs across every venue it works). */
  async listPrNetwork(organizationId: string, actor: RequestUser | undefined) {
    this.assertOrgAccess(actor, organizationId);
    const memberships = await this.prisma.venue_pr_memberships.findMany({
      where: { organization_id: organizationId },
      include: {
        user: { select: { id: true, name: true, username: true, email: true } },
        venue: { select: { id: true, name: true, city: true } },
      },
      orderBy: [{ venue: { name: 'asc' } }, { created_at: 'asc' }],
    });

    return memberships.map((m) => ({
      id: m.id,
      role: m.role,
      is_active: m.is_active,
      ref_code: m.ref_code,
      venue: m.venue,
      user: m.user,
      display_name: m.user.name || m.user.username || m.user.email,
      created_at: m.created_at,
    }));
  }

  /** Aggregate performance for this organization's PRs, across all its venues by default,
   * or scoped to one venue via `venueId`. Deliberately a first cut built from the tables
   * that already exist (qr scans, attributed door entries) rather than a new
   * analytics/snapshot pipeline - refine once real KPI requirements are defined. */
  async getStats(
    organizationId: string,
    actor: RequestUser | undefined,
    venueId?: string,
  ) {
    this.assertOrgAccess(actor, organizationId);

    const membershipWhere = {
      organization_id: organizationId,
      ...(venueId ? { venue_id: venueId } : {}),
    };

    const memberships = await this.prisma.venue_pr_memberships.findMany({
      where: membershipWhere,
      select: { id: true, is_active: true, venue_id: true },
    });
    const membershipIds = memberships.map((m) => m.id);

    if (membershipIds.length === 0) {
      return {
        active_pr_count: 0,
        total_pr_count: 0,
        total_scans: 0,
        total_attributed_entries: 0,
        by_venue: [],
      };
    }

    // `entries` has no venue_id column of its own (only event_id) - unlike qr_scans, which
    // does carry venue_id directly. Since every PR membership is already scoped to exactly
    // one venue, entry counts are aggregated by membership here and then mapped to a venue
    // via the memberships list, instead of a (non-existent) groupBy on entries.venue_id.
    const [scanCount, entryCount, scansByVenue, entriesByMembership] =
      await Promise.all([
        this.prisma.venue_pr_qr_scans.count({
          where: { pr_membership_id: { in: membershipIds } },
        }),
        this.prisma.entries.count({
          where: { pr_membership_id: { in: membershipIds } },
        }),
        this.prisma.venue_pr_qr_scans.groupBy({
          by: ['venue_id'],
          where: { pr_membership_id: { in: membershipIds } },
          _count: { _all: true },
        }),
        this.prisma.entries.groupBy({
          by: ['pr_membership_id'],
          where: { pr_membership_id: { in: membershipIds } },
          _count: { _all: true },
        }),
      ]);

    const venueIdByMembershipId = new Map(
      memberships.map((m) => [m.id, m.venue_id]),
    );
    const entryCountByVenue = new Map<string, number>();
    for (const row of entriesByMembership) {
      const venueId = row.pr_membership_id
        ? venueIdByMembershipId.get(row.pr_membership_id)
        : undefined;
      if (!venueId) continue;
      entryCountByVenue.set(
        venueId,
        (entryCountByVenue.get(venueId) ?? 0) + row._count._all,
      );
    }

    const venueIds = [...new Set(memberships.map((m) => m.venue_id))];
    const venues = await this.prisma.venues.findMany({
      where: { id: { in: venueIds } },
      select: { id: true, name: true, city: true },
    });

    const byVenue = venues.map((venue) => ({
      venue,
      active_pr_count: memberships.filter(
        (m) => m.venue_id === venue.id && m.is_active,
      ).length,
      total_scans:
        scansByVenue.find((s) => s.venue_id === venue.id)?._count._all ?? 0,
      total_attributed_entries: entryCountByVenue.get(venue.id) ?? 0,
    }));

    return {
      active_pr_count: memberships.filter((m) => m.is_active).length,
      total_pr_count: memberships.length,
      total_scans: scanCount,
      total_attributed_entries: entryCount,
      by_venue: byVenue,
    };
  }

  /** Performance of the organizations working a given venue's events — venue-self (of that
   * venue) or admin. Deliberately scoped to entries/scans that carry this venue_id, which is
   * how the "locale sees org performance only within its own events" rule is enforced: there
   * is no cross-venue leak by construction, not by an extra filter that could be forgotten. */
  async getStatsForVenue(
    venueId: string,
    organizationId: string,
    actor: RequestUser | undefined,
  ) {
    const role = String(actor?.role || '').toLowerCase();
    if (role !== 'admin') {
      if (role !== 'venue' || actor?.venue_id !== venueId) {
        throw new ForbiddenException('Forbidden');
      }
    }

    const link = await this.prisma.organization_venue_links.findUnique({
      where: {
        organization_id_venue_id: {
          organization_id: organizationId,
          venue_id: venueId,
        },
      },
    });
    if (!link)
      throw new NotFoundException('Organization is not linked to this venue');

    return this.getStatsUnscoped(organizationId, venueId);
  }

  // getStats requires org-actor-based authorization; this venue-facing variant already did
  // its own authorization above (venue ownership, not org ownership), so it computes the
  // same aggregate directly instead of routing through getStats's org access check.
  private async getStatsUnscoped(organizationId: string, venueId: string) {
    const memberships = await this.prisma.venue_pr_memberships.findMany({
      where: { organization_id: organizationId, venue_id: venueId },
      select: { id: true, is_active: true },
    });
    const membershipIds = memberships.map((m) => m.id);
    if (membershipIds.length === 0) {
      return {
        active_pr_count: 0,
        total_pr_count: 0,
        total_scans: 0,
        total_attributed_entries: 0,
      };
    }
    const [totalScans, totalEntries] = await Promise.all([
      this.prisma.venue_pr_qr_scans.count({
        where: { pr_membership_id: { in: membershipIds } },
      }),
      this.prisma.entries.count({
        where: { pr_membership_id: { in: membershipIds } },
      }),
    ]);
    return {
      active_pr_count: memberships.filter((m) => m.is_active).length,
      total_pr_count: memberships.length,
      total_scans: totalScans,
      total_attributed_entries: totalEntries,
    };
  }
}
