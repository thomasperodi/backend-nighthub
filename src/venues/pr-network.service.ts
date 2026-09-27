import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/types';
import {
  emptyPrCounters,
  foldPrCounterRows,
  sumBuckets,
  addPrCounters,
} from '../common/pr/pr-metrics.util';
import { VenuesService, type PrMembershipRow } from './venues.service';

// A night out runs past midnight, but events.date is a plain calendar date: until 06:00 the
// "current night" is still yesterday's date, so a PR checking guests at 02:00 keeps seeing
// tonight's event as live instead of jumping to the next one.
const NIGHT_ROLLOVER_HOURS = 6;

export function currentNightDate(now = new Date()): Date {
  const shifted = new Date(now.getTime() - NIGHT_ROLLOVER_HOURS * 3_600_000);
  return new Date(
    Date.UTC(shifted.getFullYear(), shifted.getMonth(), shifted.getDate()),
  );
}

type DashboardScope = {
  membershipId?: string;
  /** 'team' = the membership plus its whole subtree (responsabile view). */
  scope?: 'me' | 'team';
};

type GuestRow = {
  id: string;
  type: string;
  status: string;
  guests: number;
  actual_guests: number | null;
  checked_in_at: Date | null;
  created_at: Date;
  pr_membership_id: string | null;
  user_id: string | null;
  user_name: string | null;
  user_username: string | null;
  user_avatar: string | null;
  guest_name: string | null;
  guest_surname: string | null;
};

/**
 * PR-facing endpoints that didn't exist before the Organization/PR rework: the PR's guest
 * list and recent history on a venue's dashboard, the events of every venue a PR works
 * (venue-direct + organization venues), and the responsabile's own team management
 * (`/pr-network/me/team…`), which works for both organization and venue PRs.
 *
 * Authorization always goes through VenuesService's actor/subtree helpers - never a bare
 * id lookup - so a PR can only ever reach its own subtree.
 */
@Injectable()
export class PrNetworkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly venues: VenuesService,
  ) {}

  // ── Dashboard: guests & history ─────────────────────────────────────────────

  /** Membership ids whose referrals the caller may see on this venue's dashboard. */
  private async resolveDashboardMemberships(
    venueId: string,
    user: RequestUser | undefined,
    options: DashboardScope,
  ): Promise<string[]> {
    const actor = await this.venues.getVenueAndPrActorContext(
      venueId,
      user,
      false,
    );

    let root: PrMembershipRow | null;
    if (actor.owner) {
      if (!options.membershipId) {
        throw new BadRequestException('Indica il PR (membershipId)');
      }
      root = await this.venues.resolveScannablePrMembership(venueId, {
        id: options.membershipId,
      });
      // Exclusivity: the venue never reads an organization PR's guests.
      if (
        !root ||
        (root.organization_id &&
          this.venues.normalizeAppRole(user?.role) === 'venue')
      ) {
        throw new NotFoundException('PR non trovato');
      }
    } else {
      const me = actor.membership;
      if (!me) throw new ForbiddenException('Forbidden');
      const rows = await this.venues.loadPrHierarchyRowsForActor(venueId, me);
      const allowed = this.venues.collectPrSubtree(me.id, rows);
      const rootId = options.membershipId ?? me.id;
      if (!allowed.has(rootId)) {
        throw new ForbiddenException('Puoi vedere solo il tuo team');
      }
      root = rows.find((r) => r.id === rootId) ?? me;
    }

    if (options.scope !== 'team') return [root.id];
    const rows = await this.venues.loadPrHierarchyRowsForActor(venueId, root);
    return [...this.venues.collectPrSubtree(root.id, rows)];
  }

  private async loadVenueEvent(venueId: string, eventId: string) {
    const event = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        name: true,
        date: true,
        start_time: true,
        status: true,
        venue_id: true,
      },
    });
    if (!event || event.venue_id !== venueId) {
      throw new NotFoundException('Serata non trovata in questo locale');
    }
    return event;
  }

  /** People who booked through the PR's link for one night. Privacy: name and avatar only,
   * never email or phone. */
  async listDashboardGuests(
    venueId: string,
    user: RequestUser | undefined,
    options: DashboardScope & { eventId?: string },
  ) {
    if (!options.eventId) throw new BadRequestException('Scegli una serata');
    const [event, membershipIds] = await Promise.all([
      this.loadVenueEvent(venueId, options.eventId),
      this.resolveDashboardMemberships(venueId, user, options),
    ]);

    const rows = await this.prisma.$queryRaw<GuestRow[]>(Prisma.sql`
      SELECT
        r.id,
        r.type::text AS type,
        r.status::text AS status,
        r.guests,
        r.actual_guests,
        r.checked_in_at,
        r.created_at,
        r.meta->>'pr_membership_id' AS pr_membership_id,
        r.user_id,
        u.name AS user_name,
        u.username AS user_username,
        u.avatar AS user_avatar,
        r.guest_name,
        r.guest_surname
      FROM reservations r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.event_id = ${event.id}::uuid
        AND r.meta->>'pr_membership_id' IN (${Prisma.join(membershipIds)})
      ORDER BY r.checked_in_at DESC NULLS LAST, r.created_at DESC
      LIMIT 500
    `);

    const prNames = await this.prDisplayNames(membershipIds);

    const guests = rows.map((row) => {
      const state =
        row.status === 'cancelled'
          ? ('cancelled' as const)
          : row.checked_in_at
            ? ('entered' as const)
            : ('booked' as const);
      return {
        reservation_id: row.id,
        type: row.type === 'table' ? ('table' as const) : ('entry' as const),
        guests: Number(row.guests ?? 1),
        entered_guests: row.checked_in_at
          ? Number(row.actual_guests ?? row.guests ?? 1)
          : 0,
        state,
        checked_in_at: row.checked_in_at?.toISOString() ?? null,
        booked_at: row.created_at.toISOString(),
        pr_membership_id: row.pr_membership_id,
        pr_display_name: row.pr_membership_id
          ? (prNames.get(row.pr_membership_id) ?? null)
          : null,
        user: row.user_id
          ? {
              id: row.user_id,
              name: row.user_name || row.user_username || 'Ospite',
              username: row.user_username,
              avatar: row.user_avatar,
            }
          : {
              id: null,
              // Guest-join bookings (no account): first name + surname initial only.
              name:
                [
                  row.guest_name,
                  row.guest_surname ? `${row.guest_surname[0]}.` : null,
                ]
                  .filter(Boolean)
                  .join(' ') || 'Ospite',
              username: null,
              avatar: null,
            },
      };
    });

    const active = guests.filter((g) => g.state !== 'cancelled');
    const booked = active.reduce((sum, g) => sum + g.guests, 0);
    const entered = active.reduce((sum, g) => sum + g.entered_guests, 0);

    return {
      event: {
        id: event.id,
        name: event.name,
        date: event.date.toISOString(),
        status: event.status,
        is_tonight:
          event.status !== 'CANCELLED' &&
          event.date.getTime() === currentNightDate().getTime(),
      },
      counters: {
        reservations: active.length,
        guests: booked,
        entered,
        expected: Math.max(0, booked - entered),
        cancelled: guests.length - active.length,
      },
      guests,
      generated_at: new Date().toISOString(),
    };
  }

  /** Last N nights at this venue with the PR's (or team's) link bookings vs entries. */
  async getDashboardHistory(
    venueId: string,
    user: RequestUser | undefined,
    options: DashboardScope & { limit?: number },
  ) {
    const requested = Number.isFinite(options.limit)
      ? Math.trunc(options.limit as number)
      : 8;
    const limit = Math.min(20, Math.max(1, requested));
    const membershipIds = await this.resolveDashboardMemberships(
      venueId,
      user,
      options,
    );

    const events = await this.prisma.events.findMany({
      where: {
        venue_id: venueId,
        status: { in: ['LIVE', 'CLOSED'] },
        date: { lte: currentNightDate() },
      },
      orderBy: { date: 'desc' },
      take: limit,
      select: { id: true, name: true, date: true },
    });

    const rows = await this.venues.queryPrCounters({
      membershipIds,
      eventIds: events.map((e) => e.id),
      bucket: 'event',
    });
    const counters = foldPrCounterRows(rows);

    return {
      venue_id: venueId,
      items: [...events].reverse().map((event) => {
        const total = emptyPrCounters();
        for (const id of membershipIds) {
          addPrCounters(total, sumBuckets(counters.get(id), event.id));
        }
        return {
          event_id: event.id,
          name: event.name,
          date: event.date.toISOString(),
          referral_reservations: total.referral_reservations,
          attributed_entries: total.attributed_entries,
        };
      }),
    };
  }

  private async prDisplayNames(membershipIds: string[]) {
    const rows = await this.prisma.venue_pr_memberships.findMany({
      where: { id: { in: membershipIds } },
      select: { id: true, user: { select: { name: true, username: true } } },
    });
    return new Map(
      rows.map((r) => [r.id, r.user.name || r.user.username || 'PR']),
    );
  }

  // ── /pr-network/me/events ───────────────────────────────────────────────────

  /** Upcoming (or `past`) events of every venue the caller works as an active PR: its
   * direct venues plus every venue of its organization. Tonight's live event comes first. */
  async listMyEvents(
    user: RequestUser | undefined,
    options: { past?: boolean },
  ) {
    const memberships = await this.venues.listMyPrVenueMemberships(user);
    if (!memberships.length) return [];

    // A venue can be reached both directly and through the organization: prefer the
    // organization context only when there's no direct one (it's the same PR either way).
    const byVenue = new Map<string, (typeof memberships)[number]>();
    for (const m of memberships) {
      const existing = byVenue.get(m.venue_id);
      if (
        !existing ||
        (existing.source === 'organization' && m.source === 'venue')
      ) {
        byVenue.set(m.venue_id, m);
      }
    }
    const venueIds = [...byVenue.keys()];
    const night = currentNightDate();

    const events = await this.prisma.events.findMany({
      where: {
        venue_id: { in: venueIds },
        // Event status is time-driven (EventsService.computeEffectiveStatus): DRAFT = "in
        // programma" (published, not started yet), LIVE = happening now, CLOSED = over.
        ...(options.past
          ? { status: { in: ['LIVE', 'CLOSED'] }, date: { lt: night } }
          : { status: { in: ['DRAFT', 'LIVE'] }, date: { gte: night } }),
      },
      orderBy: { date: options.past ? 'desc' : 'asc' },
      take: options.past ? 30 : 60,
      select: {
        id: true,
        name: true,
        image: true,
        date: true,
        start_time: true,
        status: true,
        venue: { select: { id: true, name: true, city: true, image: true } },
      },
    });

    const membershipIds = [...new Set(memberships.map((m) => m.membership_id))];
    const assignments = events.length
      ? await this.prisma.venue_pr_event_assignments.findMany({
          where: {
            event_id: { in: events.map((e) => e.id) },
            pr_membership_id: { in: membershipIds },
            is_active: true,
          },
          select: { event_id: true },
        })
      : [];
    const assigned = new Set(assignments.map((a) => a.event_id));

    return events.map((event) => {
      const context = byVenue.get(event.venue.id);
      return {
        id: event.id,
        name: event.name,
        image: event.image,
        date: event.date.toISOString(),
        start_time: event.start_time?.toISOString() ?? null,
        status: event.status,
        is_tonight: event.date.getTime() === night.getTime(),
        is_assigned: assigned.has(event.id),
        venue: event.venue,
        membership_id: context?.membership_id ?? null,
        source: context?.source ?? 'venue',
        organization_id: context?.organization_id ?? null,
        organization_name: context?.organization_name ?? null,
      };
    });
  }

  // ── /pr-network/me/team ─────────────────────────────────────────────────────

  /** The caller's active responsabile membership (optionally a specific one, when the user
   * leads a team in more than one context). */
  private async resolveManagingMembership(
    user: RequestUser | undefined,
    membershipId?: string,
  ): Promise<PrMembershipRow> {
    if (!user?.id) throw new ForbiddenException('Forbidden');
    const rows = await this.prisma.venue_pr_memberships.findMany({
      where: {
        user_id: user.id,
        is_active: true,
        role: 'responsabile',
        ...(membershipId ? { id: membershipId } : {}),
      },
      select: { id: true },
    });
    if (!rows.length) {
      throw new ForbiddenException(
        'Solo un responsabile attivo può gestire un team',
      );
    }
    if (rows.length > 1) {
      throw new BadRequestException(
        'Gestisci più team: indica quale (membership_id)',
      );
    }
    const me = await this.venues.loadPrMembershipByIdGlobal(rows[0].id);
    if (!me) throw new ForbiddenException('Forbidden');
    return me;
  }

  private async loadSubtree(me: PrMembershipRow) {
    const rows = await this.venues.loadPrHierarchyRowsForActor(
      me.venue_id ?? '',
      me,
    );
    return { rows, allowed: this.venues.collectPrSubtree(me.id, rows) };
  }

  async listMyTeam(user: RequestUser | undefined, membershipId?: string) {
    const me = await this.resolveManagingMembership(user, membershipId);
    const { rows, allowed } = await this.loadSubtree(me);
    return {
      membership: {
        id: me.id,
        venue_id: me.venue_id,
        organization_id: me.organization_id,
        source: me.organization_id ? 'organization' : 'venue',
      },
      members: rows
        .filter((row) => row.id !== me.id && allowed.has(row.id))
        .map((row) => ({
          id: row.id,
          role: this.venues.toPrRoleApi(row.role),
          parent_membership_id: row.parent_membership_id,
          ref_code: row.ref_code,
          is_active: Boolean(row.is_active),
          created_at: this.venues.toIsoString(row.created_at),
          display_name: row.user_name || row.user_username || 'PR',
          // No email for PR-to-PR views.
          user: {
            id: row.user_id,
            name: row.user_name,
            username: row.user_username,
            avatar: row.user_avatar ?? null,
          },
        })),
    };
  }

  /** Finds a registered user to add to the caller's team. Returns only public profile data
   * (never the email) plus whether they can be added. */
  async lookupForMyTeam(
    user: RequestUser | undefined,
    identifier: string,
    membershipId?: string,
  ) {
    const me = await this.resolveManagingMembership(user, membershipId);
    const found = await this.venues.lookupUserForPrInvite(identifier);

    let status: 'available' | 'in_network' | 'other_organization' | 'self' =
      'available';
    if (found.id === user?.id) {
      status = 'self';
    } else if (me.organization_id) {
      const existing = await this.prisma.venue_pr_memberships.findMany({
        where: { user_id: found.id, organization_id: { not: null } },
        select: { organization_id: true, is_active: true },
      });
      if (existing.some((m) => m.organization_id === me.organization_id)) {
        status = 'in_network';
      } else if (existing.some((m) => m.is_active)) {
        status = 'other_organization';
      }
    } else if (me.venue_id) {
      const existing = await this.venues.loadPrMembershipByUser(
        me.venue_id,
        found.id,
      );
      if (existing) status = 'in_network';
    }

    return {
      id: found.id,
      name: found.name,
      username: found.username,
      avatar: found.avatar ?? null,
      status,
    };
  }

  /** Adds a PR directly under the caller. Organization responsabile → organization row;
   * venue responsabile → venue row. Role is always `pr`. */
  async addToMyTeam(
    user: RequestUser | undefined,
    body: { user_id: string; membership_id?: string },
  ) {
    const me = await this.resolveManagingMembership(user, body.membership_id);
    if (body.user_id === user?.id) {
      throw new BadRequestException('Non puoi aggiungere te stesso');
    }

    const created = me.organization_id
      ? await this.venues.createOrganizationPrMember(me.organization_id, {
          user_id: body.user_id,
          role: 'pr',
          parent_membership_id: me.id,
          created_by_user_id: user?.id ?? null,
        })
      : await this.venues.createVenuePrNetworkMember(
          me.venue_id,
          {
            user_id: body.user_id,
            role: 'pr',
            parent_membership_id: me.id,
          },
          user,
        );

    return { ...created, user: { ...created.user, email: null } };
  }

  /** Only `is_active`, only inside the caller's own subtree - never deletes. */
  async updateMyTeamMember(
    user: RequestUser | undefined,
    memberId: string,
    body: { is_active: boolean; membership_id?: string },
  ) {
    const me = await this.resolveManagingMembership(user, body.membership_id);
    if (memberId === me.id) {
      throw new BadRequestException('Non puoi disattivare te stesso');
    }
    const { allowed } = await this.loadSubtree(me);
    if (!allowed.has(memberId)) {
      throw new ForbiddenException('Puoi gestire solo i PR del tuo team');
    }

    await this.prisma.venue_pr_memberships.update({
      where: { id: memberId },
      data: { is_active: Boolean(body.is_active) },
    });

    const row = await this.venues.loadPrMemberRowByIdGlobal(memberId);
    if (!row) throw new NotFoundException('PR non trovato');
    const mapped = this.venues.mapPrMember(row);
    return { ...mapped, user: { ...mapped.user, email: null } };
  }
}
