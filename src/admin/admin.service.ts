import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  ReservationStatus,
  ReservationType,
  TicketOrderStatus,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAdminVenueDto } from './dto/create-admin-venue.dto';
import { UpdateVenueContractDto } from './dto/update-venue-contract.dto';
import { UpdateUserAssignmentDto } from './dto/update-user-assignment.dto';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { AssignVenuePlanDto } from './dto/assign-venue-plan.dto';
import { TtlCache } from '../common/ttl-cache';
import { geocodeAddress } from '../common/geocoding';
import { AuditLogService } from '../common/audit/audit-log.service';

type RevenuePoint = { label: string; value: number };

type DashboardMetrics = {
  totalVenues: number;
  activeVenues: number;
  totalUsers: number;
  totalTicketsSold: number;
  totalReservations: number;
  activeUsers30d: number;
  eventsCompletedMonth: number;
  eventsActiveToday: number;
  contractsExpiringIn30d: number;
  contractsMissingData: number;
  revenueMonth: number;
  platformRevenueMonth: number;
  platformOverageRevenueMonth: number;
  reservationsToday: number;
  newUsers30d: number;
  avgOrderValue: number;
  sessions30d: number;
  avgStayMinutes30d: number;
};

type ContractSnapshot = {
  venueId: string;
  venueName: string;
  city: string;
  expiresAt: Date;
  daysLeft: number;
  estimated: boolean;
  status: string;
  monthlyFee: number | null;
  autoRenew: boolean;
  notes: string | null;
};

@Injectable()
export class AdminService {
  // Same short-TTL stopgap as VenuesService's analytics cache (see PERFORMANCE_AUDIT.md §6):
  // the dashboard's ~20-query fan-out is expensive but tolerant of a few seconds of
  // staleness, and this endpoint is admin-only/low-concurrency, so a tiny in-process cache
  // deduplicates repeated/polled hits without a pre-aggregation table.
  private readonly dashboardCache = new TtlCache();
  private static readonly DASHBOARD_CACHE_TTL_MS = 15_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  private readonly dayLabels = [
    'Dom',
    'Lun',
    'Mar',
    'Mer',
    'Gio',
    'Ven',
    'Sab',
  ];

  private toNumber(value: unknown): number {
    if (value == null) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'bigint') return Number(value);
    if (
      typeof value === 'object' &&
      value !== null &&
      'toNumber' in value &&
      typeof (value as { toNumber: () => number }).toNumber === 'function'
    ) {
      return (value as { toNumber: () => number }).toNumber();
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  private startOfMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), 1);
  }

  private nextMonth(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth() + 1, 1);
  }

  private growth(current: number, previous: number): number {
    if (previous <= 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 1000) / 10;
  }

  private sumRevenue(items: Array<{ value: number }>): number {
    return (
      Math.round(items.reduce((acc, item) => acc + item.value, 0) * 100) / 100
    );
  }

  private normalizeContractStatus(value: string | null | undefined): string {
    const current = String(value || '')
      .trim()
      .toLowerCase();

    if (!current) return 'stimato';
    if (current === 'active' || current === 'attivo') return 'active';
    if (current === 'pending' || current === 'in_attesa') return 'pending';
    if (current === 'expired' || current === 'scaduto') return 'expired';
    if (current === 'suspended' || current === 'sospeso') return 'suspended';
    return current;
  }

  private parseOptionalDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  private buildRevenueSeries(
    fromDate: Date,
    toDate: Date,
    orders: Array<{ paid_at: Date | null; amount_total: unknown }>,
    tableReservations: Array<{
      created_at: Date;
      total_amount: unknown;
    }>,
  ): RevenuePoint[] {
    const dayStart = this.startOfDay(fromDate);
    const dayEnd = this.startOfDay(toDate);

    const bucket = new Map<string, number>();
    const keyToLabel = new Map<string, string>();

    for (let day = dayStart; day <= dayEnd; day = this.addDays(day, 1)) {
      const key = day.toISOString().slice(0, 10);
      bucket.set(key, 0);
      keyToLabel.set(key, this.dayLabels[day.getDay()] ?? key);
    }

    for (const order of orders) {
      if (!order.paid_at) continue;
      const key = this.startOfDay(order.paid_at).toISOString().slice(0, 10);
      if (!bucket.has(key)) continue;
      bucket.set(
        key,
        (bucket.get(key) ?? 0) + this.toNumber(order.amount_total),
      );
    }

    for (const reservation of tableReservations) {
      const key = this.startOfDay(reservation.created_at)
        .toISOString()
        .slice(0, 10);
      if (!bucket.has(key)) continue;
      bucket.set(
        key,
        (bucket.get(key) ?? 0) + this.toNumber(reservation.total_amount),
      );
    }

    return Array.from(bucket.entries()).map(([key, total]) => ({
      label: keyToLabel.get(key) ?? key,
      value: Math.round(total * 100) / 100,
    }));
  }

  private estimateContract(venue: {
    id: string;
    name: string;
    city: string | null;
    created_at: Date;
    stripe_onboarding_completed_at: Date | null;
    contract_start_at: Date | null;
    contract_end_at: Date | null;
    contract_status: string | null;
    contract_monthly_fee: unknown;
    contract_auto_renew: boolean;
    contract_notes: string | null;
  }): ContractSnapshot {
    const sourceDate =
      venue.contract_start_at ??
      venue.stripe_onboarding_completed_at ??
      venue.created_at;
    const explicitEnd = venue.contract_end_at;
    const estimated = explicitEnd == null;
    const expiresAt = explicitEnd ?? this.addDays(sourceDate, 365);
    const diffDays = Math.ceil(
      (this.startOfDay(expiresAt).getTime() -
        this.startOfDay(new Date()).getTime()) /
        (1000 * 60 * 60 * 24),
    );
    const status = this.normalizeContractStatus(venue.contract_status);

    return {
      venueId: venue.id,
      venueName: venue.name,
      city: venue.city ?? 'N/D',
      expiresAt,
      daysLeft: diffDays,
      estimated,
      status,
      monthlyFee:
        venue.contract_monthly_fee == null
          ? null
          : this.toNumber(venue.contract_monthly_fee),
      autoRenew: Boolean(venue.contract_auto_renew),
      notes: venue.contract_notes,
    };
  }

  private async countActiveUsers30d(since: Date): Promise<number> {
    const [reservationUsers, ticketUsers, entryUsers, stayUsers] =
      await Promise.all([
        this.prisma.reservations.findMany({
          where: { created_at: { gte: since } },
          distinct: ['user_id'],
          select: { user_id: true },
        }),
        this.prisma.ticket_orders.findMany({
          where: { created_at: { gte: since } },
          distinct: ['user_id'],
          select: { user_id: true },
        }),
        this.prisma.entries.findMany({
          where: { created_at: { gte: since }, user_id: { not: null } },
          distinct: ['user_id'],
          select: { user_id: true },
        }),
        this.prisma.venue_stays.findMany({
          where: { entered_at: { gte: since } },
          distinct: ['user_id'],
          select: { user_id: true },
        }),
      ]);

    const uniqueUsers = new Set<string>();

    for (const item of reservationUsers) uniqueUsers.add(item.user_id);
    for (const item of ticketUsers) uniqueUsers.add(item.user_id);
    for (const item of entryUsers) {
      if (item.user_id) uniqueUsers.add(item.user_id);
    }
    for (const item of stayUsers) uniqueUsers.add(item.user_id);

    return uniqueUsers.size;
  }

  async getDashboard() {
    return this.dashboardCache.getOrCompute(
      'dashboard',
      AdminService.DASHBOARD_CACHE_TTL_MS,
      () => this.getDashboardUncached(),
    );
  }

  private async getDashboardUncached() {
    const now = new Date();
    const todayStart = this.startOfDay(now);
    const tomorrowStart = this.addDays(todayStart, 1);
    const monthStart = this.startOfMonth(now);
    const nextMonthStart = this.nextMonth(now);
    const weekStart = this.addDays(todayStart, -6);
    const thirtyDaysAgo = this.addDays(todayStart, -29);

    const [
      totalUsers,
      totalReservations,
      totalTicketsSoldAgg,
      newUsers30d,
      totalVenues,
      venuesRaw,
      activeVenueIds,
      eventsActiveToday,
      eventsCompletedMonth,
      reservationsToday,
      ticketOrdersMonthTotal,
      ticketOrdersMonthPaidCount,
      pendingReservations,
      failedOrdersMonth,
      venuesNeedingStripe,
      paidOrdersWeek,
      tableReservationsWeek,
      paidOrdersMonth,
      tableReservationsMonth,
      activeUsers30d,
      stays30dStats,
    ] = await Promise.all([
      this.prisma.users.count(),
      this.prisma.reservations.count(),
      this.prisma.ticket_orders.aggregate({
        where: { status: TicketOrderStatus.paid },
        _sum: { quantity: true },
      }),
      this.prisma.users.count({
        where: { created_at: { gte: thirtyDaysAgo } },
      }),
      this.prisma.venues.count(),
      this.prisma.venues.findMany({
        select: {
          id: true,
          name: true,
          city: true,
          created_at: true,
          stripe_onboarding_completed_at: true,
          contract_start_at: true,
          contract_end_at: true,
          contract_status: true,
          contract_monthly_fee: true,
          contract_auto_renew: true,
          contract_notes: true,
          plan_custom_terms: true,
          plan: {
            select: {
              monthly_price: true,
              included_events: true,
              included_people: true,
              extra_event_price: true,
              extra_person_price: true,
            },
          },
        },
      }),
      this.prisma.events.findMany({
        where: {
          OR: [
            { status: 'LIVE' },
            { date: { gte: monthStart, lt: nextMonthStart } },
          ],
        },
        select: { venue_id: true },
        distinct: ['venue_id'],
      }),
      this.prisma.events.count({
        where: { date: { gte: todayStart, lt: tomorrowStart }, status: 'LIVE' },
      }),
      this.prisma.events.count({
        where: {
          date: { gte: monthStart, lt: nextMonthStart },
          status: 'CLOSED',
        },
      }),
      this.prisma.reservations.count({
        where: { created_at: { gte: todayStart, lt: tomorrowStart } },
      }),
      this.prisma.ticket_orders.count({
        where: { created_at: { gte: monthStart, lt: nextMonthStart } },
      }),
      this.prisma.ticket_orders.count({
        where: {
          paid_at: { gte: monthStart, lt: nextMonthStart },
          status: TicketOrderStatus.paid,
        },
      }),
      this.prisma.reservations.count({
        where: { status: ReservationStatus.pending },
      }),
      this.prisma.ticket_orders.count({
        where: {
          status: {
            in: [TicketOrderStatus.cancelled, TicketOrderStatus.failed],
          },
          created_at: { gte: monthStart, lt: nextMonthStart },
        },
      }),
      this.prisma.venues.count({
        where: {
          OR: [
            { stripe_charges_enabled: false },
            { stripe_payouts_enabled: false },
          ],
        },
      }),
      this.prisma.ticket_orders.findMany({
        where: {
          status: TicketOrderStatus.paid,
          paid_at: { gte: weekStart, lt: tomorrowStart },
        },
        select: { paid_at: true, amount_total: true },
      }),
      this.prisma.reservations.findMany({
        where: {
          type: ReservationType.table,
          status: {
            in: [ReservationStatus.confirmed, ReservationStatus.completed],
          },
          created_at: { gte: weekStart, lt: tomorrowStart },
          total_amount: { not: null },
          ticket_order: { is: null },
        },
        select: { created_at: true, total_amount: true },
      }),
      this.prisma.ticket_orders.findMany({
        where: {
          status: TicketOrderStatus.paid,
          paid_at: { gte: monthStart, lt: nextMonthStart },
        },
        select: {
          amount_total: true,
          event: { select: { venue: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.reservations.findMany({
        where: {
          type: ReservationType.table,
          status: {
            in: [ReservationStatus.confirmed, ReservationStatus.completed],
          },
          created_at: { gte: monthStart, lt: nextMonthStart },
          total_amount: { not: null },
          ticket_order: { is: null },
        },
        select: {
          total_amount: true,
          event: { select: { venue: { select: { id: true, name: true } } } },
        },
      }),
      this.countActiveUsers30d(thirtyDaysAgo),
      this.prisma.venue_stays.aggregate({
        where: {
          entered_at: { gte: thirtyDaysAgo },
          duration_ms: { not: null },
        },
        _avg: { duration_ms: true },
        _count: { _all: true },
      }),
    ]);

    const weeklyRevenue = this.buildRevenueSeries(
      weekStart,
      todayStart,
      paidOrdersWeek,
      tableReservationsWeek,
    );

    const paidOrdersMonthRevenue = paidOrdersMonth.map((order) => ({
      value: this.toNumber(order.amount_total),
    }));
    const tableMonthRevenue = tableReservationsMonth.map((reservation) => ({
      value: this.toNumber(reservation.total_amount),
    }));

    const revenueMonth = this.sumRevenue([
      ...paidOrdersMonthRevenue,
      ...tableMonthRevenue,
    ]);

    const avgOrderValue =
      ticketOrdersMonthPaidCount > 0
        ? Math.round((revenueMonth / ticketOrdersMonthPaidCount) * 100) / 100
        : 0;

    const avgStayMinutes30d =
      stays30dStats._avg.duration_ms == null
        ? 0
        : Math.round(
            (this.toNumber(stays30dStats._avg.duration_ms) / 60000) * 10,
          ) / 10;
    const sessions30d = stays30dStats._count._all;

    const contracts = venuesRaw.map((venue) => this.estimateContract(venue));
    const contractsExpiringIn30d = contracts.filter(
      (item) => item.daysLeft >= 0 && item.daysLeft <= 30,
    );
    const contractsMissingData = venuesRaw.filter(
      (venue) => !venue.contract_end_at || !venue.contract_status,
    ).length;

    const activeVenues =
      activeVenueIds.length > 0 ? activeVenueIds.length : totalVenues;
    const totalTicketsSold = this.toNumber(totalTicketsSoldAgg._sum.quantity);

    // revenueMonth is the gross volume transacted through venues (ticket orders +
    // table reservations) - it is NOT what the app earns. The app's actual revenue today
    // is the flat monthly plan/contract fee charged to venues with an active contract,
    // plus metered overage (extra events/people beyond the plan's included quota - see
    // platformOverageRevenueMonth below, filled in once eventsCompletedByVenueMonth/
    // peopleAnalyzedByVenueMonth are available). Per-transaction commission exists in
    // payments.service.ts but PLATFORM_FEE_CENTS is currently 0, so it contributes nothing.
    const platformSubscriptionRevenueMonth =
      Math.round(
        venuesRaw
          .filter(
            (venue) =>
              this.normalizeContractStatus(venue.contract_status) === 'active',
          )
          .reduce(
            (sum, venue) => sum + this.toNumber(venue.contract_monthly_fee),
            0,
          ) * 100,
      ) / 100;

    const metrics: DashboardMetrics = {
      totalVenues,
      activeVenues,
      totalUsers,
      totalTicketsSold,
      totalReservations,
      activeUsers30d,
      eventsCompletedMonth,
      eventsActiveToday,
      contractsExpiringIn30d: contractsExpiringIn30d.length,
      contractsMissingData,
      revenueMonth,
      platformRevenueMonth: platformSubscriptionRevenueMonth,
      platformOverageRevenueMonth: 0,
      reservationsToday,
      newUsers30d,
      avgOrderValue,
      sessions30d,
      avgStayMinutes30d,
    };

    const topVenueMap = new Map<
      string,
      { id: string; name: string; revenue: number }
    >();

    for (const order of paidOrdersMonth) {
      const venue = order.event?.venue;
      if (!venue) continue;
      const existing = topVenueMap.get(venue.id) ?? {
        id: venue.id,
        name: venue.name,
        revenue: 0,
      };
      existing.revenue += this.toNumber(order.amount_total);
      topVenueMap.set(venue.id, existing);
    }

    for (const reservation of tableReservationsMonth) {
      const venue = reservation.event?.venue;
      if (!venue) continue;
      const existing = topVenueMap.get(venue.id) ?? {
        id: venue.id,
        name: venue.name,
        revenue: 0,
      };
      existing.revenue += this.toNumber(reservation.total_amount);
      topVenueMap.set(venue.id, existing);
    }

    const topVenues = Array.from(topVenueMap.values())
      .map((venue) => ({
        ...venue,
        revenue: Math.round(venue.revenue * 100) / 100,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const [
      eventsActiveByVenue,
      eventsCompletedByVenueMonth,
      peopleAnalyzedByVenueMonth,
    ] = await Promise.all([
      this.prisma.events.groupBy({
        by: ['venue_id'],
        where: {
          status: 'LIVE',
          date: { gte: todayStart, lt: tomorrowStart },
        },
        _count: { _all: true },
      }),
      this.prisma.events.groupBy({
        by: ['venue_id'],
        where: {
          status: 'CLOSED',
          date: { gte: monthStart, lt: nextMonthStart },
        },
        _count: { _all: true },
      }),
      this.prisma.venue_stays.groupBy({
        by: ['venue_id'],
        where: { entered_at: { gte: monthStart, lt: nextMonthStart } },
        _count: { _all: true },
      }),
    ]);

    const activeMap = new Map<string, number>();
    for (const row of eventsActiveByVenue)
      activeMap.set(row.venue_id, row._count._all);

    const completedMap = new Map<string, number>();
    for (const row of eventsCompletedByVenueMonth) {
      completedMap.set(row.venue_id, row._count._all);
    }

    const peopleMonthMap = new Map<string, number>();
    for (const row of peopleAnalyzedByVenueMonth) {
      peopleMonthMap.set(row.venue_id, row._count._all);
    }

    // Extra events/people beyond each active venue's effective quota (plan, merged with any
    // negotiated custom_terms override - see resolvePlanTerms), priced at the effective
    // extra_event_price/extra_person_price. Venues without a plan, or on a custom/Elite plan
    // with no quota set, contribute 0 (no metered quota to exceed).
    const platformOverageRevenueMonth =
      Math.round(
        venuesRaw
          .filter(
            (venue) =>
              this.normalizeContractStatus(venue.contract_status) === 'active',
          )
          .reduce((sum, venue) => {
            const terms = this.resolvePlanTerms(
              venue.plan,
              this.parseCustomTerms(venue.plan_custom_terms),
            );
            const overage = this.computeOverage(
              terms,
              completedMap.get(venue.id) ?? 0,
              peopleMonthMap.get(venue.id) ?? 0,
            );
            return sum + overage.overageCost;
          }, 0) * 100,
      ) / 100;

    metrics.platformOverageRevenueMonth = platformOverageRevenueMonth;
    metrics.platformRevenueMonth =
      Math.round(
        (platformSubscriptionRevenueMonth + platformOverageRevenueMonth) * 100,
      ) / 100;

    const expiringContracts = contractsExpiringIn30d
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .slice(0, 6)
      .map((item) => ({
        venueId: item.venueId,
        venueName: item.venueName,
        city: item.city,
        expiresAt: item.expiresAt.toISOString(),
        daysLeft: item.daysLeft,
        estimated: item.estimated,
        status: item.status,
        monthlyFee: item.monthlyFee,
        autoRenew: item.autoRenew,
        notes: item.notes,
        eventsActive: activeMap.get(item.venueId) ?? 0,
        eventsCompletedMonth: completedMap.get(item.venueId) ?? 0,
      }));

    const alerts: Array<{
      id: number;
      title: string;
      detail: string;
      severity: 'info' | 'warning' | 'critical';
    }> = [];

    if (contractsExpiringIn30d.length > 0) {
      alerts.push({
        id: 1,
        title: 'Contratti in scadenza',
        detail: `${contractsExpiringIn30d.length} locali con scadenza stimata entro 30 giorni`,
        severity: contractsExpiringIn30d.length >= 5 ? 'critical' : 'warning',
      });
    }

    if (pendingReservations > 0) {
      alerts.push({
        id: 2,
        title: 'Prenotazioni in sospeso',
        detail: `${pendingReservations} prenotazioni da confermare o chiudere`,
        severity: pendingReservations > 20 ? 'critical' : 'warning',
      });
    }

    if (venuesNeedingStripe > 0) {
      alerts.push({
        id: 3,
        title: 'Onboarding pagamenti incompleto',
        detail: `${venuesNeedingStripe} locali senza Stripe pienamente attivo`,
        severity: 'warning',
      });
    }

    if (failedOrdersMonth > 0) {
      alerts.push({
        id: 4,
        title: 'Ordini non finalizzati',
        detail: `${failedOrdersMonth} ordini cancellati/falliti nel mese corrente`,
        severity: 'info',
      });
    }

    if (alerts.length === 0) {
      alerts.push({
        id: 99,
        title: 'Operatività regolare',
        detail: 'Nessun alert critico attivo al momento',
        severity: 'info',
      });
    }

    return {
      metrics,
      revenue: weeklyRevenue,
      alerts,
      topVenues,
      ordersMonth: {
        total: ticketOrdersMonthTotal,
        paid: ticketOrdersMonthPaidCount,
      },
      expiringContracts,
    };
  }

  async getVenues() {
    const now = new Date();
    const todayStart = this.startOfDay(now);
    const tomorrowStart = this.addDays(todayStart, 1);
    const monthStart = this.startOfMonth(now);
    const nextMonthStart = this.nextMonth(now);

    const [
      allVenues,
      openStaysByVenue,
      monthStaysByVenue,
      tableCapacityByVenue,
      monthPaidOrders,
      monthTableReservations,
      todayReservations,
      activeEventsByVenue,
      completedEventsByVenue,
    ] = await Promise.all([
      this.prisma.venues.findMany({
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          name: true,
          city: true,
          address: true,
          created_at: true,
          stripe_onboarding_completed_at: true,
          stripe_charges_enabled: true,
          stripe_payouts_enabled: true,
          contract_start_at: true,
          contract_end_at: true,
          contract_status: true,
          contract_monthly_fee: true,
          contract_auto_renew: true,
          contract_notes: true,
          plan_id: true,
          plan_custom_terms: true,
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
          users: {
            where: { role: UserRole.venue },
            orderBy: { updated_at: 'desc' },
            take: 1,
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      }),
      this.prisma.venue_stays.groupBy({
        by: ['venue_id'],
        where: { exited_at: null },
        _count: { _all: true },
      }),
      this.prisma.venue_stays.groupBy({
        by: ['venue_id'],
        where: { entered_at: { gte: monthStart, lt: nextMonthStart } },
        _count: { _all: true },
      }),
      this.prisma.venue_tables.groupBy({
        by: ['venue_id'],
        _sum: { persone_max: true },
      }),
      this.prisma.ticket_orders.findMany({
        where: {
          status: TicketOrderStatus.paid,
          paid_at: { gte: monthStart, lt: nextMonthStart },
        },
        select: {
          amount_total: true,
          event: { select: { venue_id: true } },
        },
      }),
      this.prisma.reservations.findMany({
        where: {
          type: ReservationType.table,
          status: {
            in: [ReservationStatus.confirmed, ReservationStatus.completed],
          },
          created_at: { gte: monthStart, lt: nextMonthStart },
          total_amount: { not: null },
          ticket_order: { is: null },
        },
        select: {
          total_amount: true,
          event: { select: { venue_id: true } },
        },
      }),
      this.prisma.reservations.findMany({
        where: {
          created_at: { gte: todayStart, lt: tomorrowStart },
          status: {
            in: [ReservationStatus.confirmed, ReservationStatus.completed],
          },
        },
        select: {
          guests: true,
          event: { select: { venue_id: true } },
        },
      }),
      this.prisma.events.groupBy({
        by: ['venue_id'],
        where: { status: 'LIVE', date: { gte: todayStart, lt: tomorrowStart } },
        _count: { _all: true },
      }),
      this.prisma.events.groupBy({
        by: ['venue_id'],
        where: {
          status: 'CLOSED',
          date: { gte: monthStart, lt: nextMonthStart },
        },
        _count: { _all: true },
      }),
    ]);

    const openStaysMap = new Map<string, number>();
    for (const row of openStaysByVenue) {
      openStaysMap.set(row.venue_id, row._count._all);
    }

    const monthStaysMap = new Map<string, number>();
    for (const row of monthStaysByVenue) {
      monthStaysMap.set(row.venue_id, row._count._all);
    }

    const capacityMap = new Map<string, number>();
    for (const row of tableCapacityByVenue) {
      capacityMap.set(row.venue_id, this.toNumber(row._sum.persone_max));
    }

    const revenueMap = new Map<string, number>();

    for (const order of monthPaidOrders) {
      const venueId = order.event?.venue_id;
      if (!venueId) continue;
      revenueMap.set(
        venueId,
        (revenueMap.get(venueId) ?? 0) + this.toNumber(order.amount_total),
      );
    }

    for (const reservation of monthTableReservations) {
      const venueId = reservation.event?.venue_id;
      if (!venueId) continue;
      revenueMap.set(
        venueId,
        (revenueMap.get(venueId) ?? 0) +
          this.toNumber(reservation.total_amount),
      );
    }

    const todayGuestsMap = new Map<string, number>();
    for (const reservation of todayReservations) {
      const venueId = reservation.event?.venue_id;
      if (!venueId) continue;
      todayGuestsMap.set(
        venueId,
        (todayGuestsMap.get(venueId) ?? 0) + (reservation.guests ?? 0),
      );
    }

    const eventsActiveMap = new Map<string, number>();
    for (const row of activeEventsByVenue) {
      eventsActiveMap.set(row.venue_id, row._count._all);
    }

    const eventsCompletedMap = new Map<string, number>();
    for (const row of completedEventsByVenue) {
      eventsCompletedMap.set(row.venue_id, row._count._all);
    }

    const venuesWithContract = allVenues as Array<{
      id: string;
      name: string;
      city: string | null;
      address: string | null;
      created_at: Date;
      stripe_onboarding_completed_at: Date | null;
      stripe_charges_enabled: boolean;
      stripe_payouts_enabled: boolean;
      contract_start_at: Date | null;
      contract_end_at: Date | null;
      contract_status: string | null;
      contract_monthly_fee: unknown;
      contract_auto_renew: boolean;
      contract_notes: string | null;
      plan_id: string | null;
      plan_custom_terms: unknown;
      plan: {
        id: string;
        key: string;
        name: string;
        icon: string | null;
        monthly_price: unknown;
        included_events: number | null;
        included_people: number | null;
        extra_event_price: unknown;
        extra_person_price: unknown;
        is_custom: boolean;
      } | null;
      users: Array<{
        id: string;
        name: string | null;
        email: string;
      }>;
    }>;

    return venuesWithContract.map((venue) => {
      const activeGuests = openStaysMap.get(venue.id) ?? 0;
      const capacity = capacityMap.get(venue.id) ?? 0;
      const fallbackCapacity = Math.max(
        (todayGuestsMap.get(venue.id) ?? 0) * 2,
        20,
      );
      const effectiveCapacity = capacity > 0 ? capacity : fallbackCapacity;
      const occupancy = Math.min(
        100,
        Math.round((activeGuests / Math.max(1, effectiveCapacity)) * 100),
      );

      const eventsActive = eventsActiveMap.get(venue.id) ?? 0;
      const eventsCompletedMonth = eventsCompletedMap.get(venue.id) ?? 0;
      const analyzedPeopleMonth = monthStaysMap.get(venue.id) ?? 0;
      const contract = this.estimateContract({
        id: venue.id,
        name: venue.name,
        city: venue.city,
        created_at: venue.created_at,
        stripe_onboarding_completed_at: venue.stripe_onboarding_completed_at,
        contract_start_at: venue.contract_start_at,
        contract_end_at: venue.contract_end_at,
        contract_status: venue.contract_status,
        contract_monthly_fee: venue.contract_monthly_fee,
        contract_auto_renew: venue.contract_auto_renew,
        contract_notes: venue.contract_notes,
      });
      const manager = venue.users[0] ?? null;
      const customTerms = this.parseCustomTerms(venue.plan_custom_terms);
      const terms = this.resolvePlanTerms(venue.plan, customTerms);
      const overage = this.computeOverage(
        terms,
        eventsCompletedMonth,
        analyzedPeopleMonth,
      );

      return {
        id: venue.id,
        name: venue.name,
        city: venue.city ?? 'N/D',
        address: venue.address,
        status: 'Operativo',
        occupancy,
        activeGuests,
        revenue: Math.round((revenueMap.get(venue.id) ?? 0) * 100) / 100,
        eventsActive,
        eventsCompletedMonth,
        analyzedPeopleMonth,
        contractExpiresAt: contract.expiresAt.toISOString(),
        contractDaysLeft: contract.daysLeft,
        contractEstimated: contract.estimated,
        contractStartAt:
          venue.contract_start_at instanceof Date
            ? venue.contract_start_at.toISOString()
            : null,
        contractStatus: contract.status,
        contractMonthlyFee: contract.monthlyFee,
        contractAutoRenew: contract.autoRenew,
        contractNotes: contract.notes,
        planId: venue.plan_id,
        planKey: venue.plan?.key ?? null,
        planName: venue.plan?.name ?? null,
        planIcon: venue.plan?.icon ?? null,
        planIsCustom: venue.plan?.is_custom ?? false,
        planCustomTerms: customTerms,
        planMonthlyPrice: terms.monthlyPrice,
        planIncludedEvents: overage.includedEvents,
        planIncludedPeople: overage.includedPeople,
        extraEventsCount: overage.extraEventsCount,
        extraPeopleCount: overage.extraPeopleCount,
        extraEventsCost: overage.extraEventsCost,
        extraPeopleCost: overage.extraPeopleCost,
        overageCostMonth: overage.overageCost,
        billedThisMonth:
          Math.round(((contract.monthlyFee ?? 0) + overage.overageCost) * 100) /
          100,
        managerUserId: manager?.id ?? null,
        managerName: manager?.name?.trim() || manager?.email || null,
        managerEmail: manager?.email ?? null,
      };
    });
  }

  async getUsers() {
    const now = new Date();
    const activeSince = this.addDays(this.startOfDay(now), -29);

    const activeUsersSet = new Set<string>();
    const userActivityData = await Promise.all([
      // Independent of every activity aggregate below - only merged at the end via
      // `activeUsersSet`/`lastActivityMap`/`stayStatsMap` lookups - so it runs in the same
      // batch instead of after it (previously a 10th sequential round trip).
      this.prisma.users.findMany({
        orderBy: { created_at: 'desc' },
        take: 50,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          venue_id: true,
          created_at: true,
          venue: { select: { id: true, name: true } },
        },
      }),
      this.prisma.reservations.findMany({
        where: { created_at: { gte: activeSince } },
        distinct: ['user_id'],
        select: { user_id: true },
      }),
      this.prisma.ticket_orders.findMany({
        where: { created_at: { gte: activeSince } },
        distinct: ['user_id'],
        select: { user_id: true },
      }),
      this.prisma.entries.findMany({
        where: { created_at: { gte: activeSince }, user_id: { not: null } },
        distinct: ['user_id'],
        select: { user_id: true },
      }),
      this.prisma.venue_stays.findMany({
        where: { entered_at: { gte: activeSince } },
        distinct: ['user_id'],
        select: { user_id: true },
      }),
      this.prisma.reservations.groupBy({
        by: ['user_id'],
        _max: { created_at: true },
      }),
      this.prisma.ticket_orders.groupBy({
        by: ['user_id'],
        _max: { created_at: true },
      }),
      this.prisma.entries.groupBy({
        by: ['user_id'],
        where: { user_id: { not: null } },
        _max: { created_at: true },
      }),
      this.prisma.venue_stays.groupBy({
        by: ['user_id'],
        _max: { entered_at: true },
      }),
      this.prisma.venue_stays.groupBy({
        by: ['user_id'],
        where: { entered_at: { gte: activeSince } },
        _count: { _all: true },
        _avg: { duration_ms: true },
      }),
    ]);

    const [
      users,
      reservationUsers,
      ticketUsers,
      entryUsers,
      stayUsers,
      reservationLastActivity,
      ticketLastActivity,
      entryLastActivity,
      stayLastActivity,
      stayStats30d,
    ] = userActivityData;

    for (const row of reservationUsers) activeUsersSet.add(row.user_id);
    for (const row of ticketUsers) activeUsersSet.add(row.user_id);
    for (const row of entryUsers) {
      if (row.user_id) activeUsersSet.add(row.user_id);
    }
    for (const row of stayUsers) activeUsersSet.add(row.user_id);

    const lastActivityMap = new Map<string, Date>();
    const mergeActivity = (
      userId: string | null | undefined,
      value: Date | null,
    ) => {
      if (!userId || !value) return;
      const current = lastActivityMap.get(userId);
      if (!current || current.getTime() < value.getTime()) {
        lastActivityMap.set(userId, value);
      }
    };

    for (const row of reservationLastActivity) {
      mergeActivity(row.user_id, row._max.created_at);
    }
    for (const row of ticketLastActivity) {
      mergeActivity(row.user_id, row._max.created_at);
    }
    for (const row of entryLastActivity) {
      mergeActivity(row.user_id, row._max.created_at);
    }
    for (const row of stayLastActivity) {
      mergeActivity(row.user_id, row._max.entered_at);
    }

    const stayStatsMap = new Map<
      string,
      {
        sessions30d: number;
        avgStayMinutes30d: number;
      }
    >();

    for (const row of stayStats30d) {
      const avgMs =
        row._avg.duration_ms == null ? 0 : this.toNumber(row._avg.duration_ms);
      stayStatsMap.set(row.user_id, {
        sessions30d: row._count._all,
        avgStayMinutes30d: Math.round((avgMs / 60000) * 10) / 10,
      });
    }

    return users.map((user) => {
      const displayName = user.name?.trim() || user.email;
      const role = String(user.role || '').toLowerCase();
      const roleLabel =
        role === 'admin'
          ? 'Admin'
          : role === 'venue'
            ? 'Venue'
            : role === 'staff'
              ? 'Staff'
              : 'Cliente';

      const stayStats = stayStatsMap.get(user.id);

      return {
        id: user.id,
        name: displayName,
        email: user.email,
        roleKey: role,
        venueId: user.venue_id,
        venueName: user.venue?.name ?? null,
        role: user.venue?.name
          ? `${roleLabel} • ${user.venue.name}`
          : roleLabel,
        status: activeUsersSet.has(user.id) ? 'Attivo' : 'Inattivo',
        joinedAt: user.created_at,
        lastActivityAt: lastActivityMap.get(user.id) ?? null,
        sessions30d: stayStats?.sessions30d ?? 0,
        avgStayMinutes30d: stayStats?.avgStayMinutes30d ?? 0,
      };
    });
  }

  // Trust & safety: search across every user (not just the 50-most-recent list `getUsers`
  // returns for the dashboard widget) so an admin can actually find one account to act on.
  async searchUsers(search?: string) {
    const term = String(search || '').trim();
    const users = await this.prisma.users.findMany({
      where: term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              { email: { contains: term, mode: 'insensitive' } },
              { username: { contains: term, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { created_at: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        email: true,
        username: true,
        role: true,
        is_active: true,
        venue_id: true,
        created_at: true,
      },
    });
    return users;
  }

  async setUserActive(
    userIdentifier: string,
    active: boolean,
    adminId?: string,
  ) {
    const user = await this.resolveUserByIdentifier(userIdentifier);
    if (!user) {
      throw new NotFoundException(
        `User not found (looked up "${userIdentifier}" as id, email, and username)`,
      );
    }
    const updated = await this.prisma.users.update({
      where: { id: user.id },
      data: { is_active: active },
      select: {
        id: true,
        name: true,
        email: true,
        username: true,
        role: true,
        is_active: true,
      },
    });
    if (adminId) {
      this.auditLog.record({
        adminId,
        action: active ? 'user.reactivate' : 'user.suspend',
        targetType: 'user',
        targetId: user.id,
      });
    }
    // Being logged in with a short-lived (15 min) access token is the one gap a suspend
    // doesn't close instantly - see the comment on JwtAuthGuard for why that's a
    // deliberate, bounded trade-off rather than a per-request DB check.
    return updated;
  }

  // "Account" here means a venue: this is what the deleted admin-accounts screen (see git
  // history) called locali/organizzazioni. Reuses `venues.contract_status` (already a free
  // string written by the venue-contract editor) instead of adding a second status column -
  // 'suspended' was already one of its possible values, it just had no enforcement behind
  // it (see the venue-scoped guards below and in venues.controller.ts).
  async listAccounts(search?: string) {
    const term = String(search || '').trim();
    const venues = await this.prisma.venues.findMany({
      where: term
        ? {
            OR: [
              { name: { contains: term, mode: 'insensitive' } },
              { city: { contains: term, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { created_at: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        city: true,
        contract_status: true,
        contract_monthly_fee: true,
        created_at: true,
      },
    });

    return venues.map((venue) => ({
      id: venue.id,
      name: venue.name,
      type: 'venue' as const,
      location: venue.city ?? '',
      active: venue.contract_status !== 'suspended',
      revenue_label: venue.contract_monthly_fee
        ? `€${Number(venue.contract_monthly_fee).toFixed(0)}/mese`
        : '—',
      member_since: venue.created_at,
    }));
  }

  async setAccountActive(venueId: string, active: boolean, adminId?: string) {
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: { id: true, contract_status: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    const updated = await this.prisma.venues.update({
      where: { id: venueId },
      data: { contract_status: active ? 'active' : 'suspended' },
      select: {
        id: true,
        name: true,
        city: true,
        contract_status: true,
        contract_monthly_fee: true,
        created_at: true,
      },
    });

    if (adminId) {
      this.auditLog.record({
        adminId,
        action: active ? 'venue.reactivate' : 'venue.suspend',
        targetType: 'venue',
        targetId: venueId,
      });
    }

    return {
      id: updated.id,
      name: updated.name,
      type: 'venue' as const,
      location: updated.city ?? '',
      active: updated.contract_status !== 'suspended',
      revenue_label: updated.contract_monthly_fee
        ? `€${Number(updated.contract_monthly_fee).toFixed(0)}/mese`
        : '—',
      member_since: updated.created_at,
    };
  }

  async getReports() {
    const now = new Date();
    const todayStart = this.startOfDay(now);
    const monthStart = this.startOfMonth(now);
    const nextMonthStart = this.nextMonth(now);
    const previousMonthStart = this.startOfMonth(this.addDays(monthStart, -1));

    const [
      ordersCurrentMonth,
      tableCurrentMonth,
      ordersPreviousMonthSum,
      tablePreviousMonthSum,
      ordersLast30Days,
      tableLast30Days,
    ] = await Promise.all([
      this.prisma.ticket_orders.aggregate({
        where: {
          status: TicketOrderStatus.paid,
          paid_at: { gte: monthStart, lt: nextMonthStart },
        },
        _sum: { amount_total: true },
        _count: { _all: true },
      }),
      this.prisma.reservations.aggregate({
        where: {
          type: ReservationType.table,
          status: {
            in: [ReservationStatus.confirmed, ReservationStatus.completed],
          },
          created_at: { gte: monthStart, lt: nextMonthStart },
          total_amount: { not: null },
          ticket_order: { is: null },
        },
        _sum: { total_amount: true },
      }),
      this.prisma.ticket_orders.aggregate({
        where: {
          status: TicketOrderStatus.paid,
          paid_at: { gte: previousMonthStart, lt: monthStart },
        },
        _sum: { amount_total: true },
      }),
      this.prisma.reservations.aggregate({
        where: {
          type: ReservationType.table,
          status: {
            in: [ReservationStatus.confirmed, ReservationStatus.completed],
          },
          created_at: { gte: previousMonthStart, lt: monthStart },
          total_amount: { not: null },
          ticket_order: { is: null },
        },
        _sum: { total_amount: true },
      }),
      this.prisma.ticket_orders.findMany({
        where: {
          status: TicketOrderStatus.paid,
          paid_at: {
            gte: this.addDays(todayStart, -29),
            lt: this.addDays(todayStart, 1),
          },
        },
        select: { amount_total: true, paid_at: true },
      }),
      this.prisma.reservations.findMany({
        where: {
          type: ReservationType.table,
          status: {
            in: [ReservationStatus.confirmed, ReservationStatus.completed],
          },
          created_at: {
            gte: this.addDays(todayStart, -29),
            lt: this.addDays(todayStart, 1),
          },
          total_amount: { not: null },
          ticket_order: { is: null },
        },
        select: { total_amount: true, created_at: true },
      }),
    ]);

    const entriesRevenue = this.toNumber(ordersCurrentMonth._sum.amount_total);
    const tableRevenue = this.toNumber(tableCurrentMonth._sum.total_amount);
    const monthTotal = Math.round((entriesRevenue + tableRevenue) * 100) / 100;

    const prevMonthTotal =
      this.toNumber(ordersPreviousMonthSum._sum.amount_total) +
      this.toNumber(tablePreviousMonthSum._sum.total_amount);
    const monthVsPrevious = this.growth(monthTotal, prevMonthTotal);

    const monthHint =
      monthVsPrevious >= 0
        ? `Trend +${monthVsPrevious}% vs mese precedente`
        : `Trend ${monthVsPrevious}% vs mese precedente`;

    const revenue = this.buildRevenueSeries(
      this.addDays(todayStart, -6),
      todayStart,
      ordersLast30Days,
      tableLast30Days,
    );

    return {
      revenue,
      monthTotal,
      monthHint,
      monthVsPrevious,
      channelBreakdown: {
        entries: Math.round(entriesRevenue * 100) / 100,
        tables: Math.round(tableRevenue * 100) / 100,
      },
      paidOrders: ordersCurrentMonth._count._all,
    };
  }

  async createVenue(input: CreateAdminVenueDto) {
    const name = String(input?.name || '').trim();
    if (!name) throw new BadRequestException('name is required');

    const startAt = this.parseOptionalDate(input.contract_start_at);
    const endAt = this.parseOptionalDate(input.contract_end_at);
    if (input.contract_end_at && !endAt) {
      throw new BadRequestException('contract_end_at must be a valid date');
    }
    if (input.contract_start_at && !startAt) {
      throw new BadRequestException('contract_start_at must be a valid date');
    }
    if (startAt && endAt && endAt.getTime() < startAt.getTime()) {
      throw new BadRequestException(
        'contract_end_at cannot be before contract_start_at',
      );
    }

    const contractStatus = this.normalizeContractStatus(input.contract_status);
    const address = input.address?.trim() || null;
    const coords = address ? await geocodeAddress(address) : null;

    const venue = await this.prisma.venues.create({
      data: {
        name,
        city: input.city?.trim() || null,
        address,
        latitude: coords?.latitude,
        longitude: coords?.longitude,
        radius_geofence:
          input.radius_geofence === undefined
            ? undefined
            : Number(input.radius_geofence),
        contract_start_at: startAt ?? null,
        contract_end_at: endAt ?? null,
        contract_status:
          input.contract_status === undefined ? null : contractStatus,
        contract_monthly_fee:
          input.contract_monthly_fee === undefined
            ? null
            : Number(input.contract_monthly_fee),
        contract_auto_renew: Boolean(input.contract_auto_renew),
        contract_notes: input.contract_notes?.trim() || null,
      },
      select: {
        id: true,
        name: true,
        city: true,
        address: true,
        latitude: true,
        longitude: true,
        contract_start_at: true,
        contract_end_at: true,
        contract_status: true,
        contract_monthly_fee: true,
        contract_auto_renew: true,
        contract_notes: true,
      },
    });

    if (input.manager_user_id) {
      await this.updateUserAssignment(input.manager_user_id, {
        role: 'venue',
        venue_id: venue.id,
      });
    }

    return {
      ...venue,
      latitude: venue.latitude == null ? null : this.toNumber(venue.latitude),
      longitude:
        venue.longitude == null ? null : this.toNumber(venue.longitude),
      contract_monthly_fee:
        venue.contract_monthly_fee == null
          ? null
          : this.toNumber(venue.contract_monthly_fee),
    };
  }

  async updateVenueContract(venueId: string, input: UpdateVenueContractDto) {
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: { id: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    const startAt = this.parseOptionalDate(input.contract_start_at);
    const endAt = this.parseOptionalDate(input.contract_end_at);
    if (input.contract_start_at && !startAt) {
      throw new BadRequestException('contract_start_at must be a valid date');
    }
    if (input.contract_end_at && !endAt) {
      throw new BadRequestException('contract_end_at must be a valid date');
    }
    if (startAt && endAt && endAt.getTime() < startAt.getTime()) {
      throw new BadRequestException(
        'contract_end_at cannot be before contract_start_at',
      );
    }

    const data: {
      contract_start_at?: Date | null;
      contract_end_at?: Date | null;
      contract_status?: string | null;
      contract_monthly_fee?: number | null;
      contract_auto_renew?: boolean;
      contract_notes?: string | null;
    } = {};

    if (input.contract_start_at !== undefined) {
      data.contract_start_at = startAt;
    }
    if (input.contract_end_at !== undefined) {
      data.contract_end_at = endAt;
    }
    if (input.contract_status !== undefined) {
      data.contract_status = input.contract_status
        ? this.normalizeContractStatus(input.contract_status)
        : null;
    }
    if (input.contract_monthly_fee !== undefined) {
      data.contract_monthly_fee =
        input.contract_monthly_fee === null
          ? null
          : Number(input.contract_monthly_fee);
    }
    if (input.contract_auto_renew !== undefined) {
      data.contract_auto_renew = Boolean(input.contract_auto_renew);
    }
    if (input.contract_notes !== undefined) {
      data.contract_notes = input.contract_notes?.trim() || null;
    }

    const updated = await this.prisma.venues.update({
      where: { id: venueId },
      data,
      select: {
        id: true,
        name: true,
        contract_start_at: true,
        contract_end_at: true,
        contract_status: true,
        contract_monthly_fee: true,
        contract_auto_renew: true,
        contract_notes: true,
      },
    });

    return {
      ...updated,
      contract_monthly_fee:
        updated.contract_monthly_fee == null
          ? null
          : this.toNumber(updated.contract_monthly_fee),
    };
  }

  // Narrows a venue's `plan_custom_terms` JSON column back into a typed partial override.
  // Unknown/malformed shapes (manual DB edits, future schema drift) degrade to "no override"
  // per-field rather than throwing, since this is read on every dashboard/venues-list hit.
  private parseCustomTerms(value: unknown): {
    monthly_price?: number;
    included_events?: number;
    included_people?: number;
    extra_event_price?: number;
    extra_person_price?: number;
    notes?: string;
  } | null {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const out: ReturnType<AdminService['parseCustomTerms']> = {};
    if (typeof raw.monthly_price === 'number')
      out.monthly_price = raw.monthly_price;
    if (typeof raw.included_events === 'number')
      out.included_events = raw.included_events;
    if (typeof raw.included_people === 'number')
      out.included_people = raw.included_people;
    if (typeof raw.extra_event_price === 'number')
      out.extra_event_price = raw.extra_event_price;
    if (typeof raw.extra_person_price === 'number')
      out.extra_person_price = raw.extra_person_price;
    if (typeof raw.notes === 'string') out.notes = raw.notes;
    return out;
  }

  // Merges a plan's own price/quotas with a venue's negotiated overrides (if any) - an
  // override wins field-by-field when present. For a custom plan (is_custom, no defaults
  // of its own) every field effectively comes from the override.
  private resolvePlanTerms(
    plan: {
      monthly_price: unknown;
      included_events: number | null;
      included_people: number | null;
      extra_event_price: unknown;
      extra_person_price: unknown;
    } | null,
    customTerms: ReturnType<AdminService['parseCustomTerms']>,
  ) {
    const monthlyPrice =
      customTerms?.monthly_price ??
      (plan?.monthly_price == null ? null : this.toNumber(plan.monthly_price));
    const includedEvents =
      customTerms?.included_events ?? plan?.included_events ?? null;
    const includedPeople =
      customTerms?.included_people ?? plan?.included_people ?? null;
    const extraEventPrice =
      customTerms?.extra_event_price ??
      (plan?.extra_event_price == null
        ? 0
        : this.toNumber(plan.extra_event_price));
    const extraPersonPrice =
      customTerms?.extra_person_price ??
      (plan?.extra_person_price == null
        ? 0
        : this.toNumber(plan.extra_person_price));

    return {
      monthlyPrice,
      includedEvents,
      includedPeople,
      extraEventPrice,
      extraPersonPrice,
    };
  }

  // Shared by getVenues() (per-venue billing detail) and getDashboardUncached()
  // (platform-wide overage total). `null` includedEvents/includedPeople means nothing to
  // meter (no plan assigned, or a custom/Elite plan with no quota set) - no overage.
  private computeOverage(
    terms: {
      includedEvents: number | null;
      includedPeople: number | null;
      extraEventPrice: number;
      extraPersonPrice: number;
    },
    eventsCount: number,
    peopleCount: number,
  ) {
    const extraEventsCount =
      terms.includedEvents == null
        ? 0
        : Math.max(0, eventsCount - terms.includedEvents);
    const extraPeopleCount =
      terms.includedPeople == null
        ? 0
        : Math.max(0, peopleCount - terms.includedPeople);

    const extraEventsCost =
      Math.round(extraEventsCount * terms.extraEventPrice * 100) / 100;
    const extraPeopleCost =
      Math.round(extraPeopleCount * terms.extraPersonPrice * 100) / 100;

    return {
      includedEvents: terms.includedEvents,
      includedPeople: terms.includedPeople,
      extraEventsCount,
      extraPeopleCount,
      extraEventsCost,
      extraPeopleCost,
      overageCost: Math.round((extraEventsCost + extraPeopleCost) * 100) / 100,
    };
  }

  private serializePlan(plan: {
    id: string;
    key: string;
    name: string;
    tagline: string | null;
    icon: string | null;
    monthly_price: unknown;
    included_events: number | null;
    included_people: number | null;
    extra_event_price: unknown;
    extra_person_price: unknown;
    is_custom: boolean;
    is_recommended: boolean;
    is_active: boolean;
    sort_order: number;
  }) {
    return {
      id: plan.id,
      key: plan.key,
      name: plan.name,
      tagline: plan.tagline,
      icon: plan.icon,
      monthlyPrice:
        plan.monthly_price == null ? null : this.toNumber(plan.monthly_price),
      includedEvents: plan.included_events,
      includedPeople: plan.included_people,
      extraEventPrice:
        plan.extra_event_price == null
          ? null
          : this.toNumber(plan.extra_event_price),
      extraPersonPrice:
        plan.extra_person_price == null
          ? null
          : this.toNumber(plan.extra_person_price),
      isCustom: plan.is_custom,
      isRecommended: plan.is_recommended,
      isActive: plan.is_active,
      sortOrder: plan.sort_order,
    };
  }

  async listPlans() {
    const plans = await this.prisma.subscription_plans.findMany({
      orderBy: { sort_order: 'asc' },
    });
    return plans.map((plan) => this.serializePlan(plan));
  }

  async createPlan(input: CreatePlanDto) {
    const key = String(input?.key || '')
      .trim()
      .toLowerCase();
    const name = String(input?.name || '').trim();
    if (!key) throw new BadRequestException('key is required');
    if (!name) throw new BadRequestException('name is required');

    try {
      const plan = await this.prisma.subscription_plans.create({
        data: {
          key,
          name,
          tagline: input.tagline?.trim() || null,
          icon: input.icon?.trim() || null,
          monthly_price:
            input.monthly_price === undefined ? null : input.monthly_price,
          included_events:
            input.included_events === undefined ? null : input.included_events,
          included_people:
            input.included_people === undefined ? null : input.included_people,
          extra_event_price:
            input.extra_event_price === undefined
              ? null
              : input.extra_event_price,
          extra_person_price:
            input.extra_person_price === undefined
              ? null
              : input.extra_person_price,
          is_custom: Boolean(input.is_custom),
          is_recommended: Boolean(input.is_recommended),
          is_active: input.is_active === undefined ? true : input.is_active,
          sort_order: input.sort_order ?? 0,
        },
      });
      return this.serializePlan(plan);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new BadRequestException(
          `A plan with key "${key}" already exists`,
        );
      }
      throw error;
    }
  }

  async updatePlan(planId: string, input: UpdatePlanDto) {
    const existing = await this.prisma.subscription_plans.findUnique({
      where: { id: planId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Plan not found');

    const data: Prisma.subscription_plansUpdateInput = {};
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.tagline !== undefined)
      data.tagline = input.tagline?.trim() || null;
    if (input.icon !== undefined) data.icon = input.icon?.trim() || null;
    if (input.monthly_price !== undefined)
      data.monthly_price = input.monthly_price;
    if (input.included_events !== undefined)
      data.included_events = input.included_events;
    if (input.included_people !== undefined)
      data.included_people = input.included_people;
    if (input.extra_event_price !== undefined)
      data.extra_event_price = input.extra_event_price;
    if (input.extra_person_price !== undefined)
      data.extra_person_price = input.extra_person_price;
    if (input.is_custom !== undefined) data.is_custom = input.is_custom;
    if (input.is_recommended !== undefined)
      data.is_recommended = input.is_recommended;
    if (input.is_active !== undefined) data.is_active = input.is_active;
    if (input.sort_order !== undefined) data.sort_order = input.sort_order;

    const plan = await this.prisma.subscription_plans.update({
      where: { id: planId },
      data,
    });
    return this.serializePlan(plan);
  }

  async deletePlan(planId: string) {
    const existing = await this.prisma.subscription_plans.findUnique({
      where: { id: planId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Plan not found');

    const assignedVenues = await this.prisma.venues.count({
      where: { plan_id: planId },
    });
    if (assignedVenues > 0) {
      throw new BadRequestException(
        `Cannot delete plan: ${assignedVenues} venue(s) are still assigned to it. Reassign them first.`,
      );
    }

    await this.prisma.subscription_plans.delete({ where: { id: planId } });
    return { success: true };
  }

  async assignVenuePlan(venueId: string, input: AssignVenuePlanDto) {
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: { id: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    if (input.plan_id === undefined) {
      throw new BadRequestException('plan_id is required');
    }

    if (input.plan_id === null) {
      // Unassigning: custom terms are meaningless without a plan, so they're cleared too.
      // contract_monthly_fee is left untouched - it's a general contract field, not
      // exclusively plan-owned, and the admin may still want the venue billed manually.
      const updated = await this.prisma.venues.update({
        where: { id: venueId },
        data: { plan_id: null, plan_custom_terms: Prisma.JsonNull },
        select: { id: true, plan_id: true, contract_monthly_fee: true },
      });
      return {
        id: updated.id,
        planId: updated.plan_id,
        planCustomTerms: null,
        contractMonthlyFee:
          updated.contract_monthly_fee == null
            ? null
            : this.toNumber(updated.contract_monthly_fee),
      };
    }

    const plan = await this.prisma.subscription_plans.findUnique({
      where: { id: input.plan_id },
    });
    if (!plan) throw new NotFoundException('Plan not found');

    // custom_terms is the full override for this assignment (not a partial merge with
    // whatever was saved before) - omitting it clears any previous override.
    const customTerms = input.custom_terms ?? null;

    if (plan.is_custom && customTerms?.monthly_price === undefined) {
      throw new BadRequestException(
        'custom_terms.monthly_price is required when assigning a custom-priced plan',
      );
    }

    const terms = this.resolvePlanTerms(plan, customTerms);
    if (terms.monthlyPrice == null) {
      throw new BadRequestException(
        'Unable to resolve a monthly price for this plan - pass custom_terms.monthly_price',
      );
    }

    const updated = await this.prisma.venues.update({
      where: { id: venueId },
      data: {
        plan_id: plan.id,
        plan_custom_terms: customTerms
          ? (customTerms as unknown as Prisma.InputJsonValue)
          : Prisma.JsonNull,
        contract_monthly_fee: terms.monthlyPrice,
      },
      select: {
        id: true,
        plan_id: true,
        plan_custom_terms: true,
        contract_monthly_fee: true,
      },
    });

    return {
      id: updated.id,
      planId: updated.plan_id,
      planCustomTerms: customTerms,
      contractMonthlyFee: this.toNumber(updated.contract_monthly_fee),
      plan: this.serializePlan(plan),
      effectiveTerms: terms,
    };
  }

  // Looks a user up by id, email, or username - whichever the caller has on hand, so an
  // admin assigning a venue manager doesn't need to go find the user's UUID first. Emails
  // are matched case-insensitively (stored lowercased, see auth.service.ts); usernames are
  // matched as stored.
  private async resolveUserByIdentifier(identifier: string) {
    const value = String(identifier || '').trim();
    if (!value) return null;

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      );
    if (isUuid) {
      const byId = await this.prisma.users.findUnique({ where: { id: value } });
      if (byId) return byId;
    }

    if (value.includes('@')) {
      const byEmail = await this.prisma.users.findUnique({
        where: { email: value.toLowerCase() },
      });
      if (byEmail) return byEmail;
    }

    return this.prisma.users.findUnique({ where: { username: value } });
  }

  async updateUserAssignment(
    userIdentifier: string,
    input: UpdateUserAssignmentDto,
  ) {
    const user = await this.resolveUserByIdentifier(userIdentifier);
    if (!user) {
      throw new NotFoundException(
        `User not found (looked up "${userIdentifier}" as id, email, and username)`,
      );
    }
    const userId = user.id;

    const role = String(input.role || '')
      .trim()
      .toLowerCase() as UserRole;

    if (!Object.values(UserRole).includes(role)) {
      throw new BadRequestException('Invalid role');
    }

    const needsVenue = role === UserRole.venue || role === UserRole.staff;
    const venueId = input.venue_id ?? null;
    if (needsVenue && !venueId) {
      throw new BadRequestException('venue_id required for venue/staff role');
    }

    if (venueId) {
      const venueExists = await this.prisma.venues.findUnique({
        where: { id: venueId },
        select: { id: true },
      });
      if (!venueExists) throw new NotFoundException('Venue not found');
    }

    // Mirrors the venue_id handling above: an `organization` role account represents that
    // organization's own login, the same way a `venue` role account represents a locale's.
    const needsOrganization = role === UserRole.organization;
    const organizationId = input.organization_id ?? null;
    if (needsOrganization && !organizationId) {
      throw new BadRequestException(
        'organization_id required for organization role',
      );
    }

    if (organizationId) {
      const organizationExists = await this.prisma.organizations.findUnique({
        where: { id: organizationId },
        select: { id: true },
      });
      if (!organizationExists)
        throw new NotFoundException('Organization not found');
    }

    const updatedUser = await this.prisma.users.update({
      where: { id: userId },
      data: {
        role,
        venue_id: needsVenue ? venueId : null,
        organization_id: needsOrganization ? organizationId : null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        venue_id: true,
        venue: { select: { name: true } },
        organization_id: true,
        organization: { select: { name: true } },
      },
    });

    return {
      id: updatedUser.id,
      name: updatedUser.name || updatedUser.email,
      email: updatedUser.email,
      role: updatedUser.role,
      venueId: updatedUser.venue_id,
      venueName: updatedUser.venue?.name ?? null,
      organizationId: updatedUser.organization_id,
      organizationName: updatedUser.organization?.name ?? null,
    };
  }

  async listAuditLog(filter: { targetType?: string; targetId?: string }) {
    return this.prisma.admin_audit_logs.findMany({
      where: {
        ...(filter.targetType ? { target_type: filter.targetType } : {}),
        ...(filter.targetId ? { target_id: filter.targetId } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: 200,
    });
  }

  async getProfile(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        name: true,
        email: true,
        role: true,
      },
    });

    if (!user) {
      throw new NotFoundException('Admin user not found');
    }

    const role = String(user.role || '').toLowerCase();
    const roleLabel = role === 'admin' ? 'Admin' : role;

    return {
      name: user.name?.trim() || user.email,
      email: user.email,
      role: roleLabel,
    };
  }

  // Richer than getProfile() - meant for an admin "account/settings" screen: identity,
  // other admins on the team (support contacts), and the same operational alerts shown on
  // the dashboard (reused via getDashboard()'s own 15s cache, so this stays cheap).
  async getMe(userId: string) {
    const [user, dashboard] = await Promise.all([
      this.prisma.users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          username: true,
          phone: true,
          avatar: true,
          role: true,
          created_at: true,
          last_active_at: true,
        },
      }),
      this.getDashboard(),
    ]);

    if (!user) throw new NotFoundException('Admin user not found');

    const team = await this.prisma.users.findMany({
      where: { role: UserRole.admin, id: { not: userId } },
      select: { id: true, name: true, email: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });

    return {
      id: user.id,
      name: user.name?.trim() || user.email,
      email: user.email,
      username: user.username,
      phone: user.phone,
      avatar: user.avatar,
      role: 'admin',
      createdAt: user.created_at,
      lastActiveAt: user.last_active_at,
      team: team.map((admin) => ({
        id: admin.id,
        name: admin.name?.trim() || admin.email,
        email: admin.email,
        createdAt: admin.created_at,
      })),
      alerts: dashboard.alerts,
    };
  }
}
