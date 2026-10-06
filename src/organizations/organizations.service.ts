import {
  BadRequestException,
  ForbiddenException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../common/audit/audit-log.service';
import { VenuesService } from '../venues/venues.service';
import {
  resolvePlanTerms,
  computeOverage,
  billingMonth,
  toNumber,
} from '../common/billing/plan-usage.util';
import { MEASURED_STAY_WHERE } from '../venue-stays/venue-stays.service';
import {
  addPrCounters,
  emptyPrCounters,
  foldPrCounterRows,
  rollupTeamCounters,
  sumBuckets,
  toPrMetrics,
} from '../common/pr/pr-metrics.util';
import { Prisma, UserRole } from '@prisma/client';
import type { RequestUser } from '../auth/types';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { CreateOrganizationPrMemberDto } from './dto/create-organization-pr-member.dto';
import { UpdateOrganizationPrMemberDto } from './dto/update-organization-pr-member.dto';

export interface PrStatsFilters {
  venue_id?: string;
  /** Inclusive lower bound on the event date. */
  from?: Date;
  /** Exclusive upper bound on the event date. */
  to?: Date;
}

function displayName(user: {
  name: string | null;
  username: string | null;
  email?: string | null;
}) {
  return user.name || user.username || user.email || 'Utente';
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    @Inject(forwardRef(() => VenuesService))
    private readonly venuesService: VenuesService,
  ) {}

  // Organization-id ownership for getById/listVenues/listPrNetwork/getStats is enforced by
  // OrganizationOwnershipGuard at the controller level (see organizations.controller.ts),
  // not re-checked here - this is what closes the "guard centralizzata" gap flagged in the
  // NightHub audit's Fase 5 recap: a single reusable guard instead of a
  // per-service-method if/throw.
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
        plan: { select: { id: true, key: true, name: true, icon: true } },
        owners: {
          select: { id: true, name: true, username: true, email: true },
        },
      },
    });
  }

  async getById(organizationId: string) {
    const organization = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
      include: {
        venue_links: {
          include: { venue: { select: { id: true, name: true, city: true } } },
        },
        plan: { select: { id: true, key: true, name: true, icon: true } },
        owners: {
          select: { id: true, name: true, username: true, email: true },
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
        'Nessuna organizzazione collegata a questo account',
      );
    }
    return this.getById(actor.organization_id);
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

  /** Admin-only hard delete. Venue links cascade (FK). In the same transaction:
   * - the organization's own PR network (rows with organization_id = this org and no venue_id,
   *   i.e. exclusive to it) is deleted, cascading its event assignments/QR scans/passes;
   *   entries keep their history (pr_membership_id SetNull). Venue PRs merely tagged with the
   *   org keep working for their venue (organization_id SetNull).
   * - owner accounts (`role: organization`) are demoted to `client`, so they don't end up as
   *   an organization login with no organization.
   * - events it created stay with their venue (events.organization_id SetNull). */
  async remove(organizationId: string, actor: RequestUser | undefined) {
    this.assertAdmin(actor);
    const existing = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true },
    });
    if (!existing) throw new NotFoundException('Organization not found');

    await this.prisma.$transaction([
      this.prisma.venue_pr_memberships.deleteMany({
        where: { organization_id: organizationId, venue_id: null },
      }),
      this.prisma.users.updateMany({
        where: { organization_id: organizationId, role: UserRole.organization },
        data: { role: UserRole.client, organization_id: null },
      }),
      this.prisma.organizations.delete({ where: { id: organizationId } }),
    ]);

    if (actor?.id) {
      this.auditLog.record({
        adminId: actor.id,
        action: 'organization.delete',
        targetType: 'organization',
        targetId: organizationId,
        metadata: { name: existing.name },
      });
    }

    return { success: true };
  }

  // Billing lives on organizations (confirmed business decision) - one flat plan per
  // organization, using the shared subscription_plans catalog. The equivalent legacy
  // per-venue plan (venues.plan_id) was removed entirely 2026-08-20.
  async assignPlan(
    organizationId: string,
    planId: string | null | undefined,
    actor: RequestUser | undefined,
  ) {
    this.assertAdmin(actor);
    const existing = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Organization not found');

    if (planId) {
      const plan = await this.prisma.subscription_plans.findUnique({
        where: { id: planId },
        select: { id: true },
      });
      if (!plan) throw new NotFoundException('Plan not found');
    }

    const organization = await this.prisma.organizations.update({
      where: { id: organizationId },
      data: { plan_id: planId ?? null },
      include: {
        plan: { select: { id: true, key: true, name: true, icon: true } },
      },
    });

    if (actor?.id) {
      this.auditLog.record({
        adminId: actor.id,
        action: 'organization.assign_plan',
        targetType: 'organization',
        targetId: organizationId,
        metadata: { plan_id: planId ?? null },
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

  // A PR's membership is no longer scoped through a single venue link (see
  // venue_pr_memberships.organization_id's doc comment) - it covers every venue the
  // organization is linked to, so unlinking one venue no longer deactivates the organization's
  // PR memberships; they simply stop covering this venue and keep working the others.
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

    await this.prisma.organization_venue_links.delete({
      where: { id: link.id },
    });

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
  async listVenues(organizationId: string) {
    return this.prisma.organization_venue_links.findMany({
      where: { organization_id: organizationId },
      include: {
        venue: { select: { id: true, name: true, city: true, image: true } },
      },
      orderBy: { created_at: 'desc' },
    });
  }

  /** Organizations linked to a venue — venue ownership enforced by VenueOwnershipGuard at
   * the controller level (see venues.controller.ts). Used by the venue-side "which
   * organizations work here" view and the PR-network invite form. */
  async listForVenue(venueId: string) {
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
   * business rule: the organization sees its own PRs across every venue it works). Each PR
   * is a single row (not one per venue - see venue_pr_memberships.organization_id's doc
   * comment), tagged with the full list of venues it currently covers, its resolved
   * responsabile and - with `include=stats` - the official metrics (own and team), computed
   * in one aggregate query for the whole network. */
  async listPrNetwork(
    organizationId: string,
    options: { includeStats?: boolean } & PrStatsFilters = {},
  ) {
    const [memberships, venueLinks] = await Promise.all([
      this.loadOrganizationMemberships(organizationId),
      this.prisma.organization_venue_links.findMany({
        where: { organization_id: organizationId },
        include: { venue: { select: { id: true, name: true, city: true } } },
      }),
    ]);

    const venues = venueLinks.map((link) => link.venue);
    const byId = new Map(memberships.map((m) => [m.id, m]));
    const metrics = options.includeStats
      ? await this.computeMemberMetrics(
          memberships,
          venues.map((v) => v.id),
          options,
        )
      : null;

    return memberships.map((m) => {
      const parent = m.parent_membership_id
        ? byId.get(m.parent_membership_id)
        : undefined;
      return {
        id: m.id,
        role: m.role,
        parent_membership_id: m.parent_membership_id,
        parent: parent
          ? { id: parent.id, display_name: displayName(parent.user) }
          : null,
        is_active: m.is_active,
        ref_code: m.ref_code,
        venues,
        user: m.user,
        display_name: displayName(m.user),
        team_count: memberships.filter((c) => c.parent_membership_id === m.id)
          .length,
        created_at: m.created_at,
        ...(metrics
          ? {
              stats: toPrMetrics(metrics.own(m.id)),
              team_stats: toPrMetrics(
                metrics.team.get(m.id) ?? metrics.own(m.id),
              ),
            }
          : {}),
      };
    });
  }

  /** Full detail of one organization PR: profile, own/team metrics, per-venue metrics, the
   * last 8 nights at the organization's venues and the events it's assigned to. */
  async getPrMemberDetail(
    organizationId: string,
    memberId: string,
    filters: PrStatsFilters = {},
  ) {
    const [memberships, venueLinks] = await Promise.all([
      this.loadOrganizationMemberships(organizationId),
      this.prisma.organization_venue_links.findMany({
        where: { organization_id: organizationId },
        include: { venue: { select: { id: true, name: true, city: true } } },
      }),
    ]);
    const member = memberships.find((m) => m.id === memberId);
    if (!member) throw new NotFoundException('PR non trovato nel tuo network');

    const venues = venueLinks.map((link) => link.venue);
    const venueIds = venues.map((v) => v.id);
    const now = new Date();

    const [metrics, pastEvents, assignments] = await Promise.all([
      this.computeMemberMetrics(memberships, venueIds, filters),
      venueIds.length
        ? this.prisma.events.findMany({
            where: {
              venue_id: { in: venueIds },
              status: { not: 'CANCELLED' },
              date: { lt: now },
            },
            orderBy: { date: 'desc' },
            take: 8,
            select: { id: true, name: true, date: true, venue_id: true },
          })
        : Promise.resolve(
            [] as Array<{
              id: string;
              name: string;
              date: Date;
              venue_id: string;
            }>,
          ),
      this.prisma.venue_pr_event_assignments.findMany({
        where: {
          pr_membership_id: memberId,
          is_active: true,
          event: { date: { gte: startOfDay(now) } },
        },
        orderBy: { event: { date: 'asc' } },
        select: {
          event: {
            select: {
              id: true,
              name: true,
              date: true,
              status: true,
              venue: { select: { id: true, name: true } },
            },
          },
        },
      }),
    ]);

    const historyRows = pastEvents.length
      ? await this.venuesService.queryPrCounters({
          membershipIds: [memberId],
          eventIds: pastEvents.map((e) => e.id),
          bucket: 'event',
        })
      : [];
    const perEvent = foldPrCounterRows(historyRows).get(memberId);

    const parent = member.parent_membership_id
      ? memberships.find((m) => m.id === member.parent_membership_id)
      : undefined;
    const children = memberships.filter(
      (m) => m.parent_membership_id === member.id,
    );

    return {
      id: member.id,
      role: member.role,
      is_active: member.is_active,
      ref_code: member.ref_code,
      created_at: member.created_at,
      user: { ...member.user, email: member.user.email },
      display_name: displayName(member.user),
      parent: parent
        ? { id: parent.id, display_name: displayName(parent.user) }
        : null,
      team: children.map((c) => ({
        id: c.id,
        display_name: displayName(c.user),
        is_active: c.is_active,
      })),
      stats: toPrMetrics(metrics.own(member.id)),
      team_stats: toPrMetrics(
        metrics.team.get(member.id) ?? metrics.own(member.id),
      ),
      by_venue: venues.map((venue) => ({
        venue,
        ...toPrMetrics(sumBuckets(metrics.counters.get(member.id), venue.id)),
      })),
      // Oldest first, ready to be drawn left-to-right.
      history: [...pastEvents].reverse().map((event) => {
        const c = perEvent?.get(event.id) ?? emptyPrCounters();
        return {
          event_id: event.id,
          name: event.name,
          date: event.date,
          venue_id: event.venue_id,
          referral_reservations: c.referral_reservations,
          attributed_entries: c.attributed_entries,
        };
      }),
      assigned_events: assignments.map((a) => a.event),
    };
  }

  /** Aggregate performance of this organization's PRs with the official metrics
   * (common/pr/pr-metrics.util.ts): totals, per linked venue and per member (own + team_*),
   * optionally scoped to one venue and/or a date range on the event date. One aggregate
   * query for the whole network, so the PR screen can render every row without N+1. */
  async getStats(organizationId: string, filters: PrStatsFilters = {}) {
    const [memberships, venueLinks] = await Promise.all([
      this.loadOrganizationMemberships(organizationId),
      this.prisma.organization_venue_links.findMany({
        where: {
          organization_id: organizationId,
          ...(filters.venue_id ? { venue_id: filters.venue_id } : {}),
        },
        include: { venue: { select: { id: true, name: true, city: true } } },
      }),
    ]);

    const metrics = await this.computeMemberMetrics(
      memberships,
      venueLinks.map((link) => link.venue.id),
      filters,
    );

    const totals = emptyPrCounters();
    for (const m of memberships) addPrCounters(totals, metrics.own(m.id));

    // Average stay at the organization's venues (measured exits only, see
    // MEASURED_STAY_WHERE), with the same period/venue filters as the PR metrics.
    const stayRows = venueLinks.length
      ? await this.prisma.venue_stays.groupBy({
          by: ['venue_id'],
          where: {
            venue_id: { in: venueLinks.map((l) => l.venue.id) },
            ...(filters.from || filters.to
              ? {
                  entered_at: {
                    ...(filters.from ? { gte: filters.from } : {}),
                    ...(filters.to ? { lte: filters.to } : {}),
                  },
                }
              : {}),
            ...MEASURED_STAY_WHERE,
          },
          _avg: { duration_ms: true },
          _count: { _all: true },
        })
      : [];
    const stayByVenue = new Map(stayRows.map((r) => [r.venue_id, r]));
    const minutes = (ms: number | null | undefined) =>
      ms == null ? null : Math.round(ms / 6000) / 10;
    const measured = stayRows.reduce((n, r) => n + r._count._all, 0);
    const avgStayMinutes = measured
      ? minutes(
          stayRows.reduce(
            (sum, r) => sum + (r._avg.duration_ms ?? 0) * r._count._all,
            0,
          ) / measured,
        )
      : null;

    const byVenue = venueLinks.map((link) => {
      const venueCounters = emptyPrCounters();
      for (const m of memberships) {
        addPrCounters(
          venueCounters,
          sumBuckets(metrics.counters.get(m.id), link.venue.id),
        );
      }
      return {
        venue: link.venue,
        linked_at: link.created_at,
        avg_stay_minutes: minutes(
          stayByVenue.get(link.venue.id)?._avg.duration_ms,
        ),
        avg_stay_measured_count:
          stayByVenue.get(link.venue.id)?._count._all ?? 0,
        ...toPrMetrics(venueCounters),
        // Legacy names, kept while clients migrate to the official ones above.
        total_scans: venueCounters.scans,
        total_attributed_entries: venueCounters.attributed_entries,
      };
    });

    const byMember = memberships.map((m) => {
      const team = toPrMetrics(metrics.team.get(m.id) ?? metrics.own(m.id));
      return {
        membership_id: m.id,
        ...toPrMetrics(metrics.own(m.id)),
        team_referral_reservations: team.referral_reservations,
        team_referral_guests: team.referral_guests,
        team_attributed_entries: team.attributed_entries,
        team_conversion_rate: team.conversion_rate,
        team_scans: team.scans,
      };
    });

    return {
      venue_id: filters.venue_id ?? null,
      from: filters.from?.toISOString() ?? null,
      to: filters.to?.toISOString() ?? null,
      active_pr_count: memberships.filter((m) => m.is_active).length,
      total_pr_count: memberships.length,
      responsabili_count: memberships.filter((m) => m.role === 'responsabile')
        .length,
      ...toPrMetrics(totals),
      total_scans: totals.scans,
      total_attributed_entries: totals.attributed_entries,
      // null = no measured stay yet (only geofence exits count).
      avg_stay_minutes: avgStayMinutes,
      avg_stay_measured_count: measured,
      by_venue: byVenue,
      by_member: byMember,
    };
  }

  /** Performance of the organizations working a given venue's events — venue ownership
   * enforced by VenueOwnershipGuard at the controller level. Exclusivity rule: the venue only
   * ever sees the organization's aggregate at its own venue, never the individual PRs, so
   * by_member / by_venue are deliberately dropped here. */
  async getStatsForVenue(venueId: string, organizationId: string) {
    const link = await this.prisma.organization_venue_links.findUnique({
      where: {
        organization_id_venue_id: {
          organization_id: organizationId,
          venue_id: venueId,
        },
      },
    });
    if (!link)
      throw new NotFoundException(
        'Organizzazione non collegata a questo locale',
      );

    const stats = await this.getStats(organizationId, { venue_id: venueId });
    return {
      active_pr_count: stats.active_pr_count,
      total_pr_count: stats.total_pr_count,
      referral_reservations: stats.referral_reservations,
      referral_guests: stats.referral_guests,
      attributed_entries: stats.attributed_entries,
      conversion_rate: stats.conversion_rate,
      scans: stats.scans,
      total_scans: stats.total_scans,
      total_attributed_entries: stats.total_attributed_entries,
    };
  }

  private async loadOrganizationMemberships(organizationId: string) {
    const rows = await this.prisma.venue_pr_memberships.findMany({
      where: { organization_id: organizationId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            username: true,
            email: true,
            avatar: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      role: m.role,
      parent_membership_id: m.parent_membership_id,
      is_active: m.is_active,
      ref_code: m.ref_code,
      created_at: m.created_at,
      user: m.user,
    }));
  }

  private async computeMemberMetrics(
    memberships: Array<{ id: string; parent_membership_id: string | null }>,
    venueIds: string[],
    filters: PrStatsFilters,
  ) {
    const rows =
      memberships.length && venueIds.length
        ? await this.venuesService.queryPrCounters({
            membershipIds: memberships.map((m) => m.id),
            venueIds,
            from: filters.from,
            to: filters.to,
            bucket: 'venue',
          })
        : [];
    const counters = foldPrCounterRows(rows);
    const own = (id: string) => sumBuckets(counters.get(id));
    const team = rollupTeamCounters(memberships, own);
    return { counters, own, team };
  }

  // PR-network mutations - organization ownership already enforced by
  // OrganizationOwnershipGuard at the controller level. Delegates to VenuesService's
  // organization-scoped siblings (create/update/deleteOrganizationPrMember), which reuse the
  // same hierarchy/ref-code logic as the venue-side PR network without letting an
  // organization touch a venue's own PRs or another organization's - see the doc comment on
  // those methods in venues.service.ts.
  async createPrMember(
    organizationId: string,
    dto: CreateOrganizationPrMemberDto,
  ) {
    return this.venuesService.createOrganizationPrMember(organizationId, {
      user_id: dto.user_id,
      role: dto.role,
      parent_membership_id: dto.parent_membership_id,
      ref_code: dto.ref_code,
    });
  }

  /** Resolves an id/email/username into a user before inviting them to the organization's PR
   * network - org-scoped counterpart to VenuesService.lookupUserForPrInvite, since an
   * organization-invited PR isn't tied to any one of the org's venues (see
   * createOrganizationPrMember). */
  async lookupPrInviteUser(organizationId: string, identifier: string) {
    const user = await this.venuesService.lookupUserForPrInvite(identifier);
    // Tells the invite sheet up front what createOrganizationPrMember would answer, so it
    // can show "Già nel tuo network" / "Lavora già per un'altra organizzazione" on step 1.
    const memberships = await this.prisma.venue_pr_memberships.findMany({
      where: { user_id: user.id, organization_id: { not: null } },
      select: { organization_id: true, is_active: true },
    });
    const status = memberships.some((m) => m.organization_id === organizationId)
      ? ('in_network' as const)
      : memberships.some((m) => m.is_active)
        ? ('other_organization' as const)
        : ('available' as const);
    return { ...user, status };
  }

  async regeneratePrRefCode(organizationId: string, memberId: string) {
    return this.venuesService.regenerateOrganizationPrRefCode(
      organizationId,
      memberId,
    );
  }

  private async loadOrganizationEvent(organizationId: string, eventId: string) {
    const event = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        date: true,
        status: true,
        venue_id: true,
        organization_id: true,
      },
    });
    if (!event) throw new NotFoundException('Evento non trovato');
    if (event.organization_id === organizationId) return event;
    // The organization's PRs work every night at its linked venues, including the venue's
    // own events - so it may assign them there too. Anything else: 404 (not 403), no
    // existence leak across tenants.
    const link = await this.prisma.organization_venue_links.findUnique({
      where: {
        organization_id_venue_id: {
          organization_id: organizationId,
          venue_id: event.venue_id,
        },
      },
      select: { id: true },
    });
    if (!link) throw new NotFoundException('Evento non trovato');
    return event;
  }

  /** The organization's PRs with an `assigned` flag for one of its events. Only assigned PRs
   * can have their QR scans registered by the staff; the referral link works regardless. */
  async listEventPrAssignments(organizationId: string, eventId: string) {
    await this.loadOrganizationEvent(organizationId, eventId);
    const [memberships, assignments] = await Promise.all([
      this.loadOrganizationMemberships(organizationId),
      this.prisma.venue_pr_event_assignments.findMany({
        where: {
          event_id: eventId,
          pr_membership: { organization_id: organizationId },
        },
        select: { pr_membership_id: true, is_active: true },
      }),
    ]);
    const assigned = new Set(
      assignments.filter((a) => a.is_active).map((a) => a.pr_membership_id),
    );
    const byId = new Map(memberships.map((m) => [m.id, m]));
    return memberships.map((m) => {
      const parent = m.parent_membership_id
        ? byId.get(m.parent_membership_id)
        : undefined;
      return {
        membership_id: m.id,
        role: m.role,
        is_active: m.is_active,
        ref_code: m.ref_code,
        display_name: displayName(m.user),
        user: {
          id: m.user.id,
          name: m.user.name,
          username: m.user.username,
          avatar: m.user.avatar,
        },
        parent: parent
          ? { id: parent.id, display_name: displayName(parent.user) }
          : null,
        assigned: assigned.has(m.id),
      };
    });
  }

  /** Replaces the assigned set for an event: `membership_ids` is the complete list (anything
   * not in it gets is_active=false, never deleted), `all_active` assigns every active PR. */
  async setEventPrAssignments(
    organizationId: string,
    eventId: string,
    body: { membership_ids?: string[]; all_active?: boolean },
    actor: RequestUser | undefined,
  ) {
    const event = await this.loadOrganizationEvent(organizationId, eventId);
    if (!body.all_active && !Array.isArray(body.membership_ids)) {
      throw new BadRequestException(
        'Indica i PR da assegnare (membership_ids) oppure all_active',
      );
    }

    const memberships = await this.loadOrganizationMemberships(organizationId);
    const byId = new Map(memberships.map((m) => [m.id, m]));
    const target = new Set<string>(
      body.all_active
        ? memberships.filter((m) => m.is_active).map((m) => m.id)
        : (body.membership_ids ?? []),
    );
    for (const id of target) {
      const m = byId.get(id);
      if (!m) throw new BadRequestException('PR non trovato nel tuo network');
      if (!m.is_active) {
        throw new BadRequestException(
          `${displayName(m.user)} è disattivato: riattivalo prima di assegnarlo`,
        );
      }
    }

    const toDeactivate = memberships
      .filter((m) => !target.has(m.id))
      .map((m) => m.id);

    await this.prisma.$transaction([
      ...[...target].map((membershipId) =>
        this.prisma.venue_pr_event_assignments.upsert({
          where: {
            event_id_pr_membership_id: {
              event_id: eventId,
              pr_membership_id: membershipId,
            },
          },
          create: {
            venue_id: event.venue_id,
            event_id: eventId,
            pr_membership_id: membershipId,
            is_active: true,
            assigned_by_user_id: actor?.id ?? null,
          },
          update: {
            is_active: true,
            assigned_by_user_id: actor?.id ?? null,
          },
        }),
      ),
      ...(toDeactivate.length
        ? [
            this.prisma.venue_pr_event_assignments.updateMany({
              where: {
                event_id: eventId,
                pr_membership_id: { in: toDeactivate },
                is_active: true,
              },
              data: { is_active: false },
            }),
          ]
        : []),
    ]);

    return this.listEventPrAssignments(organizationId, eventId);
  }

  async updatePrMember(
    organizationId: string,
    memberId: string,
    dto: UpdateOrganizationPrMemberDto,
  ) {
    return this.venuesService.updateOrganizationPrMember(
      organizationId,
      memberId,
      dto,
    );
  }

  async deletePrMember(organizationId: string, memberId: string) {
    return this.venuesService.deleteOrganizationPrMember(
      organizationId,
      memberId,
    );
  }

  /** This organization's consumption against its subscription plan for the current calendar
   * month (Europe/Rome, see billingMonth) - every non-cancelled event dated this month, any
   * status: draft/live/closed. The events counted are the organization's own ones plus the
   * ones created by the venues billed to it (decision 2026-09-28: a linked venue consumes its
   * organization's plan; a venue linked to several organizations is billed to the first one,
   * see billedVenues). "Clienti analizzati": everyone on a door list (`entry` reservations)
   * for those same events, whether or not they actually showed up (confirmed 2026-09-28).
   * Deliberately *not* real check-ins (`venue_stays`) - the plan meters what the attendance
   * forecast's personal-rate model (AttendanceForecastService) had to process to learn each
   * person's reliability, and a no-show is exactly as much analysis work as a show. Confirmed
   * decision 2026-08-20: this quota only applies at the organization level (an organization's
   * own plan) - the legacy per-venue equivalent (`venues.plan_id`) was removed the same day.
   *
   * The usage count itself resets every calendar month (a fresh query each time, nothing
   * persisted) - but the personal reliability data it's built from is never reset by this:
   * AttendanceForecastService.getPersonalRates keeps looking at a person's full reservation
   * history regardless of which month "clienti analizzati" happens to be counting right now.
   * The two are deliberately decoupled - see the doc comment there.
   *
   * Uses the shared resolvePlanTerms/computeOverage billing util (common/billing/plan-usage.util.ts). */
  async getUsage(organizationId: string) {
    const organization = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
      include: {
        plan: {
          select: {
            id: true,
            key: true,
            name: true,
            icon: true,
            monthly_price: true,
            included_events: true,
            included_people: true,
            extra_event_price: true,
            extra_person_price: true,
            is_custom: true,
          },
        },
      },
    });
    if (!organization) throw new NotFoundException('Organization not found');

    const { start: periodStart, end: periodEnd } = billingMonth();
    const venues = await this.billedVenues(organizationId);
    const { eventsCount, peopleCount, byVenue } = await this.meterUsage(
      organizationId,
      venues.map((v) => v.id),
      periodStart,
      periodEnd,
    );

    const terms = resolvePlanTerms(organization.plan, null);
    const overage = organization.plan
      ? computeOverage(terms, eventsCount, peopleCount)
      : null;

    return {
      plan: organization.plan
        ? {
            id: organization.plan.id,
            key: organization.plan.key,
            name: organization.plan.name,
            icon: organization.plan.icon,
          }
        : null,
      period: { start: periodStart, end: periodEnd },
      events_count: eventsCount,
      people_count: peopleCount,
      included_events: overage?.includedEvents ?? null,
      included_people: overage?.includedPeople ?? null,
      extra_events_count: overage?.extraEventsCount ?? 0,
      extra_people_count: overage?.extraPeopleCount ?? 0,
      extra_events_cost: overage?.extraEventsCost ?? 0,
      extra_people_cost: overage?.extraPeopleCost ?? 0,
      overage_cost: overage?.overageCost ?? 0,
      // What each venue billed to this organization consumed this month (the venue sees its
      // own row in GET /venues/:id/billing).
      by_venue: venues.map((v) => ({
        venue_id: v.id,
        venue_name: v.name,
        events_count: byVenue.get(v.id)?.events ?? 0,
        people_count: byVenue.get(v.id)?.people ?? 0,
      })),
      // Unit prices, so the organization can see what the next extra event/person would
      // cost (estimates only: NightHub invoices at month end, nothing is paid in-app).
      terms: organization.plan
        ? {
            monthly_price: terms.monthlyPrice,
            extra_event_price: terms.extraEventPrice,
            extra_person_price: terms.extraPersonPrice,
            is_custom: organization.plan.is_custom,
          }
        : null,
    };
  }

  /**
   * Venues whose events are billed to this organization: a linked venue consumes the plan of
   * its organization, including the events the venue creates itself. A venue linked to
   * several organizations is billed to the one it was linked to first, so an event is never
   * billed twice.
   */
  private async billedVenues(organizationId: string) {
    const links = await this.prisma.organization_venue_links.findMany({
      where: { organization_id: organizationId },
      select: { venue: { select: { id: true, name: true } } },
    });
    if (!links.length) return [];
    const venueIds = links.map((l) => l.venue.id);
    const firstLinks = await this.prisma.organization_venue_links.findMany({
      where: { venue_id: { in: venueIds } },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: { venue_id: true, organization_id: true },
    });
    const billedTo = new Map<string, string>();
    for (const l of firstLinks) {
      if (!billedTo.has(l.venue_id))
        billedTo.set(l.venue_id, l.organization_id);
    }
    return links
      .map((l) => l.venue)
      .filter((v) => billedTo.get(v.id) === organizationId);
  }

  /** The organization billed for a venue's events, or null (the venue is on a flat contract). */
  private async billingOrganizationForVenue(venueId: string) {
    const first = await this.prisma.organization_venue_links.findFirst({
      where: { venue_id: venueId },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      select: { organization: { select: { id: true, name: true } } },
    });
    return first?.organization ?? null;
  }

  /**
   * Plan meters for one month: the organization's own events (wherever they are) plus the
   * events created by the venues billed to it. "Clienti analizzati" = guests on the list
   * (confirmed/completed entry reservations), see the getUsage doc comment.
   */
  private async meterUsage(
    organizationId: string,
    billedVenueIds: string[],
    periodStart: Date,
    periodEnd: Date,
  ) {
    const events = await this.prisma.events.findMany({
      where: {
        status: { not: 'CANCELLED' },
        date: { gte: periodStart, lt: periodEnd },
        OR: [
          { organization_id: organizationId },
          ...(billedVenueIds.length
            ? [{ organization_id: null, venue_id: { in: billedVenueIds } }]
            : []),
        ],
      },
      select: { id: true, venue_id: true },
    });
    const guests = events.length
      ? await this.prisma.reservations.groupBy({
          by: ['event_id'],
          where: {
            event_id: { in: events.map((e) => e.id) },
            type: 'entry',
            status: { in: ['confirmed', 'completed'] },
          },
          _sum: { guests: true },
        })
      : [];
    const guestsByEvent = new Map(
      guests.map((g) => [g.event_id, g._sum.guests ?? 0]),
    );

    const byVenue = new Map<string, { events: number; people: number }>();
    let peopleCount = 0;
    for (const e of events) {
      const people = guestsByEvent.get(e.id) ?? 0;
      peopleCount += people;
      const row = byVenue.get(e.venue_id) ?? { events: 0, people: 0 };
      row.events += 1;
      row.people += people;
      byVenue.set(e.venue_id, row);
    }
    return { eventsCount: events.length, peopleCount, byVenue };
  }

  /**
   * What the venue sees about its billing in the gestionale:
   * - linked to an organization: that organization's plan, the plan's consumption this month
   *   (all its venues), the venue's own share and the estimated extras (billed to the
   *   organization, not to the venue);
   * - otherwise: its flat monthly contract.
   */
  async getVenueBilling(venueId: string) {
    const organization = await this.billingOrganizationForVenue(venueId);
    if (organization) {
      const usage = await this.getUsage(organization.id);
      const own = usage.by_venue.find((v) => v.venue_id === venueId);
      return {
        mode: 'organization' as const,
        organization,
        plan: usage.plan,
        period: usage.period,
        venue_events_count: own?.events_count ?? 0,
        venue_people_count: own?.people_count ?? 0,
        events_count: usage.events_count,
        people_count: usage.people_count,
        included_events: usage.included_events,
        included_people: usage.included_people,
        extra_events_count: usage.extra_events_count,
        extra_people_count: usage.extra_people_count,
        overage_cost: usage.overage_cost,
        terms: usage.terms,
      };
    }
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: { contract_monthly_fee: true, contract_status: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return {
      mode: 'contract' as const,
      period: billingMonth(),
      monthly_fee:
        venue.contract_monthly_fee == null
          ? null
          : toNumber(venue.contract_monthly_fee),
      contract_status: venue.contract_status,
    };
  }

  /** Every event at the venues this organization works (organization_venue_links), plus any
   * event it created at a venue it's no longer linked to - the organization's PRs work all of
   * those nights, so they all belong in its view. `is_own` marks the ones it created (only
   * those can be edited/cancelled by the organization, see EventsService). `status` is the
   * effective, time-driven status (DRAFT = scheduled, LIVE = now, CLOSED = over), computed
   * with the same DB function the status cron uses, so a stale row never shows "in
   * programma" for a night that's already over. */
  async listEvents(organizationId: string) {
    const links = await this.prisma.organization_venue_links.findMany({
      where: { organization_id: organizationId },
      select: { venue_id: true },
    });
    const venueIds = links.map((l) => l.venue_id);
    const scope: Prisma.eventsWhereInput = {
      OR: [
        { organization_id: organizationId },
        ...(venueIds.length ? [{ venue_id: { in: venueIds } }] : []),
      ],
    };

    const events = await this.prisma.events.findMany({
      where: scope,
      include: {
        venue: { select: { id: true, name: true, city: true, image: true } },
        entry_prices: true,
      },
      orderBy: { date: 'desc' },
      take: 500,
    });
    if (!events.length) return [];

    // Per-event counters in one query. PR-related counts only include this organization's
    // own PRs (the venue's own PRs work the same nights, but they're not the org's business).
    const counts = await this.prisma.$queryRaw<
      Array<{
        event_id: string;
        effective_status: string;
        list_count: number;
        entries_count: number;
        pr_assigned_count: number;
        referral_reservations: number;
        attributed_entries: number;
      }>
    >(Prisma.sql`
      SELECT
        ev.id AS event_id,
        public.compute_event_status(ev.date, ev.start_time, ev.end_time, ev.status)::text AS effective_status,
        (
          SELECT COALESCE(SUM(r.guests), 0)::int
          FROM reservations r
          WHERE r.event_id = ev.id
            AND r.type = 'entry'
            AND r.status <> 'cancelled'
        ) AS list_count,
        (
          SELECT COUNT(*)::int FROM entries e WHERE e.event_id = ev.id
        ) AS entries_count,
        (
          SELECT COUNT(*)::int
          FROM venue_pr_event_assignments a
          JOIN venue_pr_memberships m ON m.id = a.pr_membership_id
          WHERE a.event_id = ev.id
            AND a.is_active = true
            AND m.organization_id = ${organizationId}::uuid
        ) AS pr_assigned_count,
        (
          SELECT COUNT(*)::int
          FROM reservations r
          WHERE r.event_id = ev.id
            AND r.status <> 'cancelled'
            AND r.meta->>'pr_membership_id' IN (
              SELECT m.id::text
              FROM venue_pr_memberships m
              WHERE m.organization_id = ${organizationId}::uuid
            )
        ) AS referral_reservations,
        (
          SELECT COUNT(*)::int
          FROM entries e
          JOIN venue_pr_memberships m ON m.id = e.pr_membership_id
          WHERE e.event_id = ev.id
            AND m.organization_id = ${organizationId}::uuid
        ) AS attributed_entries
      FROM events ev
      WHERE ev.id IN (${Prisma.join(events.map((e) => Prisma.sql`${e.id}::uuid`))})
    `);

    const countsByEvent = new Map(counts.map((c) => [c.event_id, c]));
    return events.map((event) => {
      const c = countsByEvent.get(event.id);
      return {
        ...event,
        status: (c?.effective_status as typeof event.status) ?? event.status,
        is_own: event.organization_id === organizationId,
        list_count: Number(c?.list_count ?? 0),
        entries_count: Number(c?.entries_count ?? 0),
        pr_assigned_count: Number(c?.pr_assigned_count ?? 0),
        referral_reservations: Number(c?.referral_reservations ?? 0),
        attributed_entries: Number(c?.attributed_entries ?? 0),
      };
    });
  }
}
