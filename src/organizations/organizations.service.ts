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
  startOfMonth,
  nextMonth,
} from '../common/billing/plan-usage.util';
import {
  addPrCounters,
  emptyPrCounters,
  foldPrCounterRows,
  rollupTeamCounters,
  sumBuckets,
  toPrMetrics,
} from '../common/pr/pr-metrics.util';
import { Prisma } from '@prisma/client';
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
   * month - every non-cancelled event dated this month (`organization_id`, any status:
   * draft/live/closed), and "clienti analizzati": everyone this org put on a door list
   * (`entry` reservations) for those same events, whether or not they actually showed up.
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

    const now = new Date();
    const periodStart = startOfMonth(now);
    const periodEnd = nextMonth(now);

    const [eventsCount, peopleAnalyzed] = await Promise.all([
      // Every event this organization has on the books this month regardless of where it is
      // in its lifecycle (draft/live/closed) - a cancelled event doesn't count, since it never
      // actually consumed anything. Deliberately not restricted to CLOSED-only (that would
      // undercount: an event created for later this month wouldn't show up until it's over).
      this.prisma.events.count({
        where: {
          organization_id: organizationId,
          status: { not: 'CANCELLED' },
          date: { gte: periodStart, lt: periodEnd },
        },
      }),
      // Same event set as eventsCount above (this org's own events, same period) - sum of
      // door-list guests, cancelled reservations excluded (never actually reached the list).
      this.prisma.reservations.aggregate({
        where: {
          type: 'entry',
          status: { in: ['confirmed', 'completed'] },
          event: {
            organization_id: organizationId,
            status: { not: 'CANCELLED' },
            date: { gte: periodStart, lt: periodEnd },
          },
        },
        _sum: { guests: true },
      }),
    ]);
    const peopleCount = peopleAnalyzed._sum.guests ?? 0;

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
