import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  EventStatus,
  Gender,
  Prisma,
  ReservationStatus,
  ReservationType,
  events,
  promos,
  venue_tables,
  venues,
} from '@prisma/client';
import Stripe from 'stripe';
import { CreateVenueTablesBulkDto } from './dto/create-venue-tables-bulk.dto';
import { UpdateVenueTableDto } from './dto/update-venue-table.dto';
import { UpdateVenuePricingDto } from './dto/update-venue-pricing.dto';
import {
  BAR_PRICE_KEYS,
  DEFAULT_BAR_PRICE_LIST,
  DEFAULT_CLOAKROOM_UNIT_PRICE,
  VenueBarPriceKey,
} from './venue-pricing.constants';

type AnalyticsDistributionItem = {
  label: string;
  count: number;
  share?: number;
};

type AnalyticsEventSummary = {
  event_id: string;
  name: string;
  date: string;
  status: string;
  totalRevenue: number;
  entriesRevenue: number;
  barRevenue: number;
  cloakroomRevenue: number;
  tablesRevenue: number;
  totalEntries: number;
  totalReservations: number;
  totalTableGuests: number;
  totalPresences: number;
  avgSpendPerPresence: number;
  averageAge: number | null;
  topEntryHour: string | null;
  women: number;
  men: number;
  other: number;
  unknown: number;
};

@Injectable()
export class VenuesService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly weekdayLabels = [
    'Dom',
    'Lun',
    'Mar',
    'Mer',
    'Gio',
    'Ven',
    'Sab',
  ];

  private decimalToNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const maybeDecimal = value as { toNumber?: () => number };
    if (typeof maybeDecimal?.toNumber === 'function') {
      try {
        const n = maybeDecimal.toNumber();
        return Number.isFinite(n) ? n : 0;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  private normalizeBarPriceList(value: unknown) {
    const incomingList = Array.isArray(value) ? value : [];
    const byKey = new Map<string, number>();

    for (const raw of incomingList) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as { key?: unknown; price?: unknown };
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      if (!key || !BAR_PRICE_KEYS.has(key as VenueBarPriceKey)) continue;
      const price = Number(row.price);
      if (!Number.isFinite(price) || price < 0) continue;
      byKey.set(key, Number(price.toFixed(2)));
    }

    return DEFAULT_BAR_PRICE_LIST.map((item) => ({
      key: item.key,
      label: item.label,
      price: Number((byKey.get(item.key) ?? item.price).toFixed(2)),
    }));
  }

  private normalizeBarPriceListInput(value: unknown) {
    if (!Array.isArray(value)) {
      throw new BadRequestException('bar_price_list must be an array');
    }

    const seenKeys = new Set<string>();
    const list = value.map((raw) => {
      const row = raw as { key?: unknown; label?: unknown; price?: unknown };
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      if (!key || !BAR_PRICE_KEYS.has(key as VenueBarPriceKey)) {
        throw new BadRequestException(`Unsupported bar price key: ${key || 'unknown'}`);
      }
      if (seenKeys.has(key)) {
        throw new BadRequestException(`Duplicate bar price key: ${key}`);
      }
      seenKeys.add(key);

      const price = Number(row.price);
      if (!Number.isFinite(price) || price < 0) {
        throw new BadRequestException(`Invalid price for ${key}`);
      }

      const defaultLabel =
        DEFAULT_BAR_PRICE_LIST.find((item) => item.key === key)?.label ?? key;
      const label =
        typeof row.label === 'string' && row.label.trim().length
          ? row.label.trim()
          : defaultLabel;

      return {
        key,
        label,
        price: Number(price.toFixed(2)),
      };
    });

    if (list.length === 0) {
      throw new BadRequestException('bar_price_list cannot be empty');
    }

    return list;
  }

  private getStripeClient(): Stripe {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      throw new BadRequestException(
        'Stripe not configured: missing STRIPE_SECRET_KEY',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return new Stripe(secret, { apiVersion: '2025-02-24.acacia' });
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  private round(value: number, digits = 1): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  private average(values: number[], digits = 1): number {
    if (!values.length) return 0;
    return this.round(
      values.reduce((acc, value) => acc + value, 0) / values.length,
      digits,
    );
  }

  private calculateAge(
    birthDate?: Date | null,
    referenceDate?: Date | null,
  ): number | null {
    if (!birthDate || Number.isNaN(birthDate.getTime())) return null;
    const ref = referenceDate && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();
    let age = ref.getFullYear() - birthDate.getFullYear();
    const monthDiff = ref.getMonth() - birthDate.getMonth();
    const beforeBirthday =
      monthDiff < 0 ||
      (monthDiff === 0 && ref.getDate() < birthDate.getDate());
    if (beforeBirthday) age -= 1;
    return age >= 0 && age <= 100 ? age : null;
  }

  private ageBucket(age: number | null): string {
    if (age == null) return 'Non disponibile';
    if (age < 21) return '18-20';
    if (age < 25) return '21-24';
    if (age < 30) return '25-29';
    if (age < 35) return '30-34';
    return '35+';
  }

  private hourLabelFromDate(date?: Date | null): string | null {
    if (!date || Number.isNaN(date.getTime())) return null;
    const hours = String(date.getHours()).padStart(2, '0');
    return `${hours}:00`;
  }

  private averageHourLabel(values: number[]): string | null {
    if (!values.length) return null;
    const avg = this.average(values, 2);
    const hours = Math.floor(avg);
    const minutes = Math.round((avg - hours) * 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private topCountItem(
    source: Map<string, number>,
  ): { label: string; count: number } | null {
    let bestLabel: string | null = null;
    let bestCount = 0;
    for (const [label, count] of source.entries()) {
      if (count > bestCount) {
        bestLabel = label;
        bestCount = count;
      }
    }
    return bestLabel ? { label: bestLabel, count: bestCount } : null;
  }

  private distributionFromMap(
    source: Map<string, number>,
    total?: number,
  ): AnalyticsDistributionItem[] {
    const resolvedTotal = total ?? Array.from(source.values()).reduce((acc, value) => acc + value, 0);
    return Array.from(source.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({
        label,
        count,
        share: resolvedTotal > 0 ? this.round((count / resolvedTotal) * 100, 1) : 0,
      }));
  }

  async listVenues(): Promise<venues[]> {
    return await this.prisma.venues.findMany({
      orderBy: { created_at: 'desc' },
    });
  }

  async getVenue(id: string): Promise<venues> {
    const v = await this.prisma.venues.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Venue not found');
    return v;
  }

  async getVenuePricing(id: string): Promise<{
    venue_id: string;
    cloakroom_unit_price: number;
    bar_price_list: Array<{ key: string; label: string; price: number }>;
  }> {
    const venue = await this.prisma.venues.findUnique({
      where: { id },
      select: {
        id: true,
        cloakroom_unit_price: true,
        bar_price_list: true,
      },
    });

    if (!venue) throw new NotFoundException('Venue not found');

    const cloakroom = this.decimalToNumber(venue.cloakroom_unit_price);
    return {
      venue_id: id,
      cloakroom_unit_price: Number(
        (cloakroom > 0 ? cloakroom : DEFAULT_CLOAKROOM_UNIT_PRICE).toFixed(2),
      ),
      bar_price_list: this.normalizeBarPriceList(venue.bar_price_list),
    };
  }

  async updateVenuePricing(
    id: string,
    updates: UpdateVenuePricingDto,
  ): Promise<{
    venue_id: string;
    cloakroom_unit_price: number;
    bar_price_list: Array<{ key: string; label: string; price: number }>;
  }> {
    await this.getVenue(id);

    const data: Prisma.venuesUpdateInput = {};

    if (updates.cloakroom_unit_price !== undefined) {
      const price = Number(updates.cloakroom_unit_price);
      if (!Number.isFinite(price) || price < 0) {
        throw new BadRequestException('cloakroom_unit_price must be >= 0');
      }
      data.cloakroom_unit_price = Number(price.toFixed(2));
    }

    if (updates.bar_price_list !== undefined) {
      const normalized = this.normalizeBarPriceListInput(updates.bar_price_list);
      data.bar_price_list = normalized as Prisma.InputJsonValue;
    }

    if (Object.keys(data).length === 0) {
      return this.getVenuePricing(id);
    }

    const updated = await this.prisma.venues.update({
      where: { id },
      data,
      select: {
        id: true,
        cloakroom_unit_price: true,
        bar_price_list: true,
      },
    });

    return {
      venue_id: updated.id,
      cloakroom_unit_price: Number(
        this.decimalToNumber(updated.cloakroom_unit_price).toFixed(2),
      ),
      bar_price_list: this.normalizeBarPriceList(updated.bar_price_list),
    };
  }

  async createVenue(input: {
    name: string;
    city?: string;
    radius_geofence?: number;
    stripe_account_id?: string;
  }): Promise<venues> {
    if (!input || !input.name) {
      throw new BadRequestException('Missing required fields');
    }

    const data: Prisma.venuesCreateInput = {
      name: input.name,
      city: input.city ?? undefined,
    };

    if (input.radius_geofence !== undefined) {
      data.radius_geofence = input.radius_geofence;
    }
    if (input.stripe_account_id !== undefined) {
      data.stripe_account_id = input.stripe_account_id;
    }

    return await this.prisma.venues.create({ data });
  }

  async updateVenue(
    id: string,
    updates: Partial<{
      name?: string;
      city?: string;
      radius_geofence?: number;
      stripe_account_id?: string;
    }>,
  ): Promise<venues> {
    await this.getVenue(id);

    const data: Prisma.venuesUpdateInput = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.city !== undefined) data.city = updates.city;
    if (updates.radius_geofence !== undefined) {
      data.radius_geofence = updates.radius_geofence;
    }
    if (updates.stripe_account_id !== undefined) {
      data.stripe_account_id = updates.stripe_account_id;
    }

    return await this.prisma.venues.update({ where: { id }, data });
  }

  async deleteVenue(id: string): Promise<venues> {
    await this.getVenue(id);
    return await this.prisma.venues.delete({ where: { id } });
  }

  async listEvents(venueId: string): Promise<events[]> {
    return await this.prisma.events.findMany({
      where: { venue_id: venueId },
      orderBy: { date: 'desc' },
    });
  }

  async createStripeConnectOnboardingLink(params: {
    venueId: string;
    refreshUrl?: string;
    returnUrl?: string;
    email?: string;
  }) {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    const venue = await this.prisma.venues.findUnique({
      where: { id: params.venueId },
      select: {
        id: true,
        name: true,
        stripe_account_id: true,
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    const stripe = this.getStripeClient();

    let stripeAccountId = venue.stripe_account_id;
    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'IT',
        email: params.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: venue.name,
        },
      });
      stripeAccountId = account.id;

      await this.prisma.venues.update({
        where: { id: params.venueId },
        data: { stripe_account_id: stripeAccountId },
      });
    }

    const fallbackBase =
      process.env.STRIPE_CONNECT_RETURN_URL || 'https://example.com/stripe';
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      type: 'account_onboarding',
      refresh_url:
        params.refreshUrl ||
        `${fallbackBase}?refresh=1&venue_id=${params.venueId}`,
      return_url:
        params.returnUrl ||
        `${fallbackBase}?success=1&venue_id=${params.venueId}`,
    });

    return {
      venue_id: params.venueId,
      stripe_account_id: stripeAccountId,
      onboarding_url: accountLink.url,
      expires_at: accountLink.expires_at,
    };
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
  }

  async getStripeConnectStatus(venueId: string) {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: {
        id: true,
        stripe_account_id: true,
        stripe_charges_enabled: true,
        stripe_payouts_enabled: true,
        stripe_onboarding_completed_at: true,
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    if (!venue.stripe_account_id) {
      return {
        venue_id: venueId,
        connected: false,
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      };
    }

    const stripe = this.getStripeClient();
    const account = await stripe.accounts.retrieve(venue.stripe_account_id);

    const chargesEnabled = Boolean(account.charges_enabled);
    const payoutsEnabled = Boolean(account.payouts_enabled);
    const detailsSubmitted = Boolean(account.details_submitted);

    await this.prisma.venues.update({
      where: { id: venueId },
      data: {
        stripe_charges_enabled: chargesEnabled,
        stripe_payouts_enabled: payoutsEnabled,
        stripe_onboarding_completed_at:
          chargesEnabled && payoutsEnabled ? new Date() : null,
      },
    });

    return {
      venue_id: venueId,
      connected: true,
      stripe_account_id: venue.stripe_account_id,
      charges_enabled: chargesEnabled,
      payouts_enabled: payoutsEnabled,
      details_submitted: detailsSubmitted,
      requirements_due: account.requirements?.currently_due ?? [],
    };
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
  }

  async listPromos(venueId: string): Promise<promos[]> {
    return await this.prisma.promos.findMany({
      where: { venue_id: venueId },
      orderBy: { created_at: 'desc' },
    });
  }

  async listVenueTables(venueId: string): Promise<venue_tables[]> {
    // Ensure venue exists
    await this.getVenue(venueId);

    return await this.prisma.venue_tables.findMany({
      where: { venue_id: venueId },
      orderBy: [{ zona: 'asc' }, { nome: 'asc' }],
    });
  }

  async createVenueTablesBulk(
    venueId: string,
    body: CreateVenueTablesBulkDto,
  ): Promise<venue_tables[]> {
    await this.getVenue(venueId);

    const tables = body?.tables;
    if (!Array.isArray(tables) || tables.length === 0) {
      throw new BadRequestException('tables[] is required');
    }

    // Keep it safe: avoid accidental huge payloads
    if (tables.length > 300) {
      throw new BadRequestException('Too many tables (max 300 per request)');
    }

    await this.prisma.$transaction(async (tx) => {
      for (const t of tables) {
        if (!t?.nome || typeof t.nome !== 'string') {
          throw new BadRequestException('Each table must have nome');
        }

        const zonaRaw =
          t.zona === null || t.zona === undefined ? '' : String(t.zona).trim();
        const nomeRaw = String(t.nome).trim();
        const zoneMode = zonaRaw.length > 0;
        const normalizedNome = zoneMode
          ? (nomeRaw || zonaRaw)
          : nomeRaw;
        const normalizedZona = zoneMode ? zonaRaw : undefined;

        if (!normalizedNome) {
          throw new BadRequestException('nome cannot be empty');
        }

        const perTesta =
          t.per_testa === null || t.per_testa === undefined
            ? undefined
            : Number(t.per_testa);
        if (
          perTesta !== undefined &&
          (!Number.isFinite(perTesta) || perTesta < 0)
        ) {
          throw new BadRequestException('per_testa must be a number >= 0');
        }

        const costoMinimo =
          t.costo_minimo === null || t.costo_minimo === undefined
            ? undefined
            : Number(t.costo_minimo);
        if (
          costoMinimo !== undefined &&
          (!Number.isFinite(costoMinimo) || costoMinimo < 0)
        ) {
          throw new BadRequestException('costo_minimo must be a number >= 0');
        }

        const personeMax =
          t.persone_max === null || t.persone_max === undefined
            ? undefined
            : Number(t.persone_max);
        if (
          personeMax !== undefined &&
          (!Number.isInteger(personeMax) || personeMax < 1)
        ) {
          throw new BadRequestException('persone_max must be an integer >= 1');
        }

        if (!zoneMode) {
          throw new BadRequestException('zona is required');
        }

        const existingZone = (await tx.venue_tables.findFirst({
          where: {
            venue_id: venueId,
            zona: { equals: zonaRaw, mode: 'insensitive' },
          },
          select: { id: true },
        })) as { id: string } | null;

        if (existingZone) {
          await tx.venue_tables.update({
            where: { id: existingZone.id },
            data: {
              nome: normalizedNome,
              zona: normalizedZona,
              numero: null,
              per_testa: perTesta,
              costo_minimo: costoMinimo,
              persone_max: personeMax,
            },
          });
        } else {
          await tx.venue_tables.create({
            data: {
              venue_id: venueId,
              nome: normalizedNome,
              zona: normalizedZona,
              numero: null,
              per_testa: perTesta,
              costo_minimo: costoMinimo,
              persone_max: personeMax,
            },
          });
        }
      }
    });

    return this.listVenueTables(venueId);
  }

  async deleteVenueTable(
    venueId: string,
    tableId: string,
  ): Promise<venue_tables> {
    await this.getVenue(venueId);

    const existing = (await this.prisma.venue_tables.findUnique({
      where: { id: tableId },
      select: { id: true, venue_id: true },
    })) as { id: string; venue_id: string } | null;
    if (!existing || existing.venue_id !== venueId) {
      throw new NotFoundException('Table not found');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const salesCount = await tx.table_sales.count({
          where: {
            event_table: {
              venue_table_id: tableId,
            },
          },
        });

        if (salesCount > 0) {
          throw new BadRequestException(
            'Cannot delete table: sales are associated with this table',
          );
        }

        await tx.reservations.updateMany({
          where: { venue_table_id: tableId },
          data: { venue_table_id: null },
        });

        await tx.event_tables.deleteMany({
          where: { venue_table_id: tableId },
        });

        return await tx.venue_tables.delete({ where: { id: tableId } });
      });
    } catch (error: unknown) {
      if (error instanceof BadRequestException) throw error;

      const prismaCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';

      if (prismaCode === 'P2003') {
        throw new BadRequestException(
          'Cannot delete table: it is still linked to event data',
        );
      }

      throw error;
    }
  }

  async updateVenueTable(
    venueId: string,
    tableId: string,
    body: UpdateVenueTableDto,
  ): Promise<venue_tables> {
    await this.getVenue(venueId);

    const existing = (await this.prisma.venue_tables.findUnique({
      where: { id: tableId },
      select: { id: true, venue_id: true },
    })) as { id: string; venue_id: string } | null;
    if (!existing || existing.venue_id !== venueId) {
      throw new NotFoundException('Table not found');
    }

    const data: Prisma.venue_tablesUpdateInput = {};

    if (body?.nome !== undefined) {
      const trimmed = String(body.nome).trim();
      if (!trimmed) throw new BadRequestException('nome cannot be empty');
      data.nome = trimmed;
    }

    if (body?.zona !== undefined) {
      const trimmed = String(body.zona).trim();
      if (!trimmed.length) {
        throw new BadRequestException('zona cannot be empty');
      }

      data.zona = trimmed;

      const clashByZone = (await this.prisma.venue_tables.findFirst({
        where: {
          venue_id: venueId,
          id: { not: tableId },
          zona: { equals: trimmed, mode: 'insensitive' },
        },
        select: { id: true },
      })) as { id: string } | null;
      if (clashByZone) {
        throw new BadRequestException('zona already exists for this venue');
      }

      if (!body?.nome) {
        data.nome = trimmed;
      }
    }

    if (body?.per_testa !== undefined && body.per_testa !== null) {
      const v = Number(body.per_testa);
      if (!Number.isFinite(v) || v < 0) {
        throw new BadRequestException('per_testa must be a number >= 0');
      }
      data.per_testa = v;
    }

    if (body?.costo_minimo !== undefined && body.costo_minimo !== null) {
      const v = Number(body.costo_minimo);
      if (!Number.isFinite(v) || v < 0) {
        throw new BadRequestException('costo_minimo must be a number >= 0');
      }
      data.costo_minimo = v;
    }

    if (body?.persone_max !== undefined && body.persone_max !== null) {
      const v = Number(body.persone_max);
      if (!Number.isInteger(v) || v < 1) {
        throw new BadRequestException('persone_max must be an integer >= 1');
      }
      data.persone_max = v;
    }

    if (body?.per_testa === null) data.per_testa = null;
    if (body?.costo_minimo === null) data.costo_minimo = null;
    if (body?.persone_max === null) data.persone_max = null;
    data.numero = null;

    return await this.prisma.venue_tables.update({
      where: { id: tableId },
      data,
    });
  }

  async getStats(venueId: string): Promise<{
    eventsCount: number;
    promosCount: number;
    reservationsCount: number;
    totalReservationAmount: number;
  }> {
    const [eventsCount, promosCount, reservationsCount, reservationsSum] =
      await this.prisma.$transaction([
        this.prisma.events.count({ where: { venue_id: venueId } }),
        this.prisma.promos.count({ where: { venue_id: venueId } }),
        this.prisma.reservations.count({
          where: { event: { venue_id: venueId } },
        }),
        this.prisma.reservations.aggregate({
          where: { event: { venue_id: venueId }, total_amount: { not: null } },
          _sum: { total_amount: true },
        }),
      ]);

    let totalReservationAmount = 0;
    const rawTotal = reservationsSum._sum?.total_amount;
    if (rawTotal !== null && rawTotal !== undefined) {
      const totalAsUnknown = rawTotal as unknown;
      if (
        typeof totalAsUnknown === 'object' &&
        totalAsUnknown !== null &&
        typeof (totalAsUnknown as Record<string, unknown>).toNumber ===
          'function'
      ) {
        totalReservationAmount = (
          totalAsUnknown as Record<string, () => number>
        ).toNumber();
      } else {
        totalReservationAmount = Number(rawTotal) || 0;
      }
    }

    return {
      eventsCount,
      promosCount,
      reservationsCount,
      totalReservationAmount,
    };
  }

  async getAnalytics(venueId: string) {
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: { id: true, name: true },
    });

    if (!venue) throw new NotFoundException('Venue not found');

    const rawEvents = await this.prisma.events.findMany({
      where: { venue_id: venueId },
      orderBy: [{ date: 'desc' }, { start_time: 'desc' }],
      select: {
        id: true,
        name: true,
        date: true,
        status: true,
        start_time: true,
        end_time: true,
      },
    });

    if (rawEvents.length === 0) {
      return {
        venue_id: venueId,
        venue_name: venue.name,
        generated_at: new Date().toISOString(),
        overview: {
          totalRevenue: 0,
          totalEntries: 0,
          totalReservations: 0,
          totalTableGuests: 0,
          totalPresences: 0,
          avgRevenuePerEvent: 0,
          avgRevenuePerPresence: 0,
          avgStayMinutes: 0,
        },
        audience: {
          uniqueCustomers: 0,
          repeatCustomers: 0,
          repeatRate: 0,
          averageAge: null,
          genderSplit: [],
          ageBuckets: [],
          ageEntryWindows: [],
        },
        bookings: {
          avgLeadDays: 0,
          bestEventWeekday: null,
          bestBookingWeekday: null,
          bestBookingHour: null,
          busiestEntryHour: null,
          byEventWeekday: [],
          byBookingWeekday: [],
          byBookingHour: [],
          leadTimeBuckets: [],
        },
        revenue: {
          channelMix: [],
          averagePerClosedEvent: {
            revenue: 0,
            entriesRevenue: 0,
            barRevenue: 0,
            cloakroomRevenue: 0,
            tablesRevenue: 0,
            entries: 0,
            presences: 0,
          },
          weekdayBenchmarks: [],
        },
        historical: {
          totalEvents: 0,
          closedEvents: 0,
          topEvent: null,
        },
        events: [],
      };
    }

    const eventIds = rawEvents.map((event) => event.id);

    const [
      entries,
      reservations,
      barTotals,
      cloakTotals,
      tableTotals,
      directEntryRevenueRows,
      stayAggregate,
    ] = await Promise.all([
      this.prisma.entries.findMany({
        where: { event_id: { in: eventIds } },
        select: {
          id: true,
          event_id: true,
          user_id: true,
          sesso: true,
          price: true,
          created_at: true,
          user: {
            select: {
              id: true,
              sesso: true,
              birth_date: true,
            },
          },
        },
      }),
      this.prisma.reservations.findMany({
        where: { event_id: { in: eventIds } },
        select: {
          id: true,
          event_id: true,
          user_id: true,
          type: true,
          status: true,
          guests: true,
          total_amount: true,
          created_at: true,
          checked_in_at: true,
          checkin_entry_id: true,
          user: {
            select: {
              id: true,
              sesso: true,
              birth_date: true,
            },
          },
        },
      }),
      this.prisma.bar_sales.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds } },
        _sum: { amount: true },
      }),
      this.prisma.cloakroom_sales.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds } },
        _sum: { amount: true },
      }),
      this.prisma.event_tables.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds } },
        _sum: { pagato_totale: true, prenotati: true },
      }),
      this.prisma.$queryRaw<Array<{ event_id: string; total: Prisma.Decimal | null }>>(
        Prisma.sql`
          SELECT e."event_id", COALESCE(SUM(e."price"), 0) AS total
          FROM "entries" e
          LEFT JOIN "reservations" r ON r."checkin_entry_id" = e."id"
          WHERE e."event_id" IN (${Prisma.join(eventIds.map((id) => Prisma.sql`${id}::uuid`))})
            AND (r."id" IS NULL OR r."total_amount" IS NULL)
          GROUP BY e."event_id"
        `,
      ),
      this.prisma.venue_stays.aggregate({
        where: { venue_id: venueId, duration_ms: { not: null } },
        _avg: { duration_ms: true },
      }),
    ]);

    const eventMeta = new Map(
      rawEvents.map((event) => [
        event.id,
        {
          id: event.id,
          name: event.name,
          date: event.date,
          status: event.status ?? EventStatus.DRAFT,
          start_time: event.start_time,
          end_time: event.end_time,
        },
      ]),
    );

    const eventMetrics = new Map<
      string,
      {
        event_id: string;
        name: string;
        date: string;
        status: string;
        entriesRevenue: number;
        barRevenue: number;
        cloakroomRevenue: number;
        tablesRevenue: number;
        totalEntries: number;
        totalReservations: number;
        totalTableGuests: number;
        totalPresences: number;
        women: number;
        men: number;
        other: number;
        unknown: number;
        topEntryHour: string | null;
        ageValues: number[];
        hourCounts: Map<string, number>;
      }
    >();

    for (const event of rawEvents) {
      eventMetrics.set(event.id, {
        event_id: event.id,
        name: event.name,
        date: event.date.toISOString(),
        status: String(event.status ?? EventStatus.DRAFT),
        entriesRevenue: 0,
        barRevenue: 0,
        cloakroomRevenue: 0,
        tablesRevenue: 0,
        totalEntries: 0,
        totalReservations: 0,
        totalTableGuests: 0,
        totalPresences: 0,
        women: 0,
        men: 0,
        other: 0,
        unknown: 0,
        topEntryHour: null,
        ageValues: [],
        hourCounts: new Map<string, number>(),
      });
    }

    const entryRevenueMap = new Map<string, number>();
    for (const row of directEntryRevenueRows) {
      entryRevenueMap.set(row.event_id, this.decimalToNumber(row.total));
    }

    for (const row of barTotals) {
      const current = eventMetrics.get(row.event_id);
      if (current) current.barRevenue = this.decimalToNumber(row._sum.amount);
    }

    for (const row of cloakTotals) {
      const current = eventMetrics.get(row.event_id);
      if (current) current.cloakroomRevenue = this.decimalToNumber(row._sum.amount);
    }

    for (const row of tableTotals) {
      const current = eventMetrics.get(row.event_id);
      if (!current) continue;
      current.tablesRevenue = this.decimalToNumber(row._sum.pagato_totale);
      current.totalTableGuests = Number(row._sum.prenotati ?? 0);
    }

    const bookingByEventWeekday = new Map<string, number>();
    const bookingByCreatedWeekday = new Map<string, number>();
    const bookingByHour = new Map<string, number>();
    const leadTimeBuckets = new Map<string, number>([
      ['0-2 gg', 0],
      ['3-7 gg', 0],
      ['8-14 gg', 0],
      ['15+ gg', 0],
    ]);
    const leadDays: number[] = [];
    const userEventsMap = new Map<string, Set<string>>();
    const seenVisits = new Set<string>();
    const reservedEntryIds = new Set(
      reservations
        .filter(
          (reservation) =>
            reservation.checkin_entry_id && reservation.total_amount != null,
        )
        .map((reservation) => reservation.checkin_entry_id as string),
    );

    const globalGenderCounts = new Map<string, number>([
      ['Donna', 0],
      ['Uomo', 0],
      ['Altro', 0],
      ['Non dichiarato', 0],
    ]);
    const audienceAgeValues: number[] = [];
    const ageBucketCounts = new Map<string, number>([
      ['18-20', 0],
      ['21-24', 0],
      ['25-29', 0],
      ['30-34', 0],
      ['35+', 0],
      ['Non disponibile', 0],
    ]);
    const ageEntryWindowMap = new Map<
      string,
      { count: number; hours: number[]; hourCounts: Map<string, number> }
    >();
    const entryHourCounts = new Map<string, number>();

    const addGender = (
      metrics:
        | {
            women: number;
            men: number;
            other: number;
            unknown: number;
          }
        | null,
      gender?: Gender | null,
    ) => {
      if (gender === Gender.F) {
        if (metrics) metrics.women += 1;
        globalGenderCounts.set('Donna', (globalGenderCounts.get('Donna') ?? 0) + 1);
        return;
      }
      if (gender === Gender.M) {
        if (metrics) metrics.men += 1;
        globalGenderCounts.set('Uomo', (globalGenderCounts.get('Uomo') ?? 0) + 1);
        return;
      }
      if (gender === Gender.ALTRO) {
        if (metrics) metrics.other += 1;
        globalGenderCounts.set('Altro', (globalGenderCounts.get('Altro') ?? 0) + 1);
        return;
      }
      if (metrics) metrics.unknown += 1;
      globalGenderCounts.set(
        'Non dichiarato',
        (globalGenderCounts.get('Non dichiarato') ?? 0) + 1,
      );
    };

    const registerVisit = (params: {
      eventId: string;
      userId?: string | null;
      gender?: Gender | null;
      birthDate?: Date | null;
    }) => {
      const metrics = eventMetrics.get(params.eventId);
      if (!metrics) return;

      if (!params.userId) {
        addGender(metrics, params.gender);
        const age = this.calculateAge(
          params.birthDate,
          eventMeta.get(params.eventId)?.date ?? null,
        );
        if (age != null) {
          metrics.ageValues.push(age);
          audienceAgeValues.push(age);
          ageBucketCounts.set(
            this.ageBucket(age),
            (ageBucketCounts.get(this.ageBucket(age)) ?? 0) + 1,
          );
        } else {
          ageBucketCounts.set(
            'Non disponibile',
            (ageBucketCounts.get('Non disponibile') ?? 0) + 1,
          );
        }
        return;
      }

      const visitKey = `${params.userId}:${params.eventId}`;
      if (seenVisits.has(visitKey)) return;
      seenVisits.add(visitKey);

      if (!userEventsMap.has(params.userId)) {
        userEventsMap.set(params.userId, new Set<string>());
      }
      userEventsMap.get(params.userId)?.add(params.eventId);

      addGender(metrics, params.gender);

      const age = this.calculateAge(
        params.birthDate,
        eventMeta.get(params.eventId)?.date ?? null,
      );
      if (age != null) {
        metrics.ageValues.push(age);
        audienceAgeValues.push(age);
        ageBucketCounts.set(
          this.ageBucket(age),
          (ageBucketCounts.get(this.ageBucket(age)) ?? 0) + 1,
        );
      } else {
        ageBucketCounts.set(
          'Non disponibile',
          (ageBucketCounts.get('Non disponibile') ?? 0) + 1,
        );
      }
    };

    for (const entry of entries) {
      const metrics = eventMetrics.get(entry.event_id);
      if (!metrics) continue;

      metrics.totalEntries += 1;

      const hourLabel = this.hourLabelFromDate(entry.created_at);
      if (hourLabel) {
        metrics.hourCounts.set(hourLabel, (metrics.hourCounts.get(hourLabel) ?? 0) + 1);
        entryHourCounts.set(hourLabel, (entryHourCounts.get(hourLabel) ?? 0) + 1);
      }

      registerVisit({
        eventId: entry.event_id,
        userId: entry.user_id,
        gender: entry.user?.sesso ?? entry.sesso,
        birthDate: entry.user?.birth_date,
      });

      const age = this.calculateAge(
        entry.user?.birth_date,
        eventMeta.get(entry.event_id)?.date ?? null,
      );
      const bucket = this.ageBucket(age);
      const currentBucket = ageEntryWindowMap.get(bucket) ?? {
        count: 0,
        hours: [],
        hourCounts: new Map<string, number>(),
      };

      currentBucket.count += 1;
      if (entry.created_at) {
        const hourValue = entry.created_at.getHours() + entry.created_at.getMinutes() / 60;
        currentBucket.hours.push(hourValue);
      }
      if (hourLabel) {
        currentBucket.hourCounts.set(
          hourLabel,
          (currentBucket.hourCounts.get(hourLabel) ?? 0) + 1,
        );
      }
      ageEntryWindowMap.set(bucket, currentBucket);

      if (!reservedEntryIds.has(entry.id) && entry.user_id) {
        const bucketKey = this.ageBucket(age);
        ageBucketCounts.set(
          bucketKey,
          ageBucketCounts.get(bucketKey) ?? 0,
        );
      }
    }

    for (const reservation of reservations) {
      const metrics = eventMetrics.get(reservation.event_id);
      const meta = eventMeta.get(reservation.event_id);
      if (!metrics || !meta) continue;

      if (reservation.status !== ReservationStatus.cancelled) {
        metrics.totalReservations += 1;

        const eventWeekday = this.weekdayLabels[meta.date.getDay()] ?? 'N/D';
        const bookingWeekday = this.weekdayLabels[reservation.created_at.getDay()] ?? 'N/D';
        const bookingHour = this.hourLabelFromDate(reservation.created_at) ?? 'N/D';

        bookingByEventWeekday.set(
          eventWeekday,
          (bookingByEventWeekday.get(eventWeekday) ?? 0) + 1,
        );
        bookingByCreatedWeekday.set(
          bookingWeekday,
          (bookingByCreatedWeekday.get(bookingWeekday) ?? 0) + 1,
        );
        bookingByHour.set(bookingHour, (bookingByHour.get(bookingHour) ?? 0) + 1);

        const leadDaysValue = Math.max(
          0,
          Math.round(
            (this.startOfDay(meta.date).getTime() - this.startOfDay(reservation.created_at).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        );
        leadDays.push(leadDaysValue);

        if (leadDaysValue <= 2) leadTimeBuckets.set('0-2 gg', (leadTimeBuckets.get('0-2 gg') ?? 0) + 1);
        else if (leadDaysValue <= 7) leadTimeBuckets.set('3-7 gg', (leadTimeBuckets.get('3-7 gg') ?? 0) + 1);
        else if (leadDaysValue <= 14) leadTimeBuckets.set('8-14 gg', (leadTimeBuckets.get('8-14 gg') ?? 0) + 1);
        else leadTimeBuckets.set('15+ gg', (leadTimeBuckets.get('15+ gg') ?? 0) + 1);

        registerVisit({
          eventId: reservation.event_id,
          userId: reservation.user_id,
          gender: reservation.user?.sesso ?? null,
          birthDate: reservation.user?.birth_date,
        });
      }

      if (
        reservation.type === ReservationType.entry &&
        (reservation.status === ReservationStatus.confirmed ||
          reservation.status === ReservationStatus.completed) &&
        reservation.total_amount != null
      ) {
        metrics.entriesRevenue += this.decimalToNumber(reservation.total_amount);
      }
    }

    for (const [eventId, revenue] of entryRevenueMap.entries()) {
      const metrics = eventMetrics.get(eventId);
      if (metrics) metrics.entriesRevenue += revenue;
    }

    const eventSummaries: AnalyticsEventSummary[] = Array.from(eventMetrics.values())
      .map((metrics) => {
        const totalRevenue =
          metrics.entriesRevenue +
          metrics.barRevenue +
          metrics.cloakroomRevenue +
          metrics.tablesRevenue;
        const totalPresences = metrics.totalEntries + metrics.totalTableGuests;
        const topEntryHour = this.topCountItem(metrics.hourCounts)?.label ?? null;

        return {
          event_id: metrics.event_id,
          name: metrics.name,
          date: metrics.date,
          status: metrics.status,
          totalRevenue: this.round(totalRevenue, 2),
          entriesRevenue: this.round(metrics.entriesRevenue, 2),
          barRevenue: this.round(metrics.barRevenue, 2),
          cloakroomRevenue: this.round(metrics.cloakroomRevenue, 2),
          tablesRevenue: this.round(metrics.tablesRevenue, 2),
          totalEntries: metrics.totalEntries,
          totalReservations: metrics.totalReservations,
          totalTableGuests: metrics.totalTableGuests,
          totalPresences,
          avgSpendPerPresence:
            totalPresences > 0 ? this.round(totalRevenue / totalPresences, 2) : 0,
          averageAge:
            metrics.ageValues.length > 0 ? this.average(metrics.ageValues, 1) : null,
          topEntryHour,
          women: metrics.women,
          men: metrics.men,
          other: metrics.other,
          unknown: metrics.unknown,
        };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const closedEvents = eventSummaries.filter((event) => event.status === String(EventStatus.CLOSED));
    const comparisonBase = closedEvents.length > 0 ? closedEvents : eventSummaries;

    const overviewTotals = eventSummaries.reduce(
      (acc, event) => {
        acc.totalRevenue += event.totalRevenue;
        acc.totalEntries += event.totalEntries;
        acc.totalReservations += event.totalReservations;
        acc.totalTableGuests += event.totalTableGuests;
        acc.totalPresences += event.totalPresences;
        acc.entriesRevenue += event.entriesRevenue;
        acc.barRevenue += event.barRevenue;
        acc.cloakroomRevenue += event.cloakroomRevenue;
        acc.tablesRevenue += event.tablesRevenue;
        return acc;
      },
      {
        totalRevenue: 0,
        totalEntries: 0,
        totalReservations: 0,
        totalTableGuests: 0,
        totalPresences: 0,
        entriesRevenue: 0,
        barRevenue: 0,
        cloakroomRevenue: 0,
        tablesRevenue: 0,
      },
    );

    const weekdayBenchmarksMap = new Map<
      string,
      {
        revenue: number[];
        entries: number[];
        presences: number[];
      }
    >();

    for (const event of closedEvents) {
      const weekday = this.weekdayLabels[new Date(event.date).getDay()] ?? 'N/D';
      const current = weekdayBenchmarksMap.get(weekday) ?? {
        revenue: [],
        entries: [],
        presences: [],
      };
      current.revenue.push(event.totalRevenue);
      current.entries.push(event.totalEntries);
      current.presences.push(event.totalPresences);
      weekdayBenchmarksMap.set(weekday, current);
    }

    const weekdayBenchmarks = Array.from(weekdayBenchmarksMap.entries()).map(
      ([label, value]) => ({
        label,
        eventCount: value.revenue.length,
        avgRevenue: this.average(value.revenue, 2),
        avgEntries: this.average(value.entries, 1),
        avgPresences: this.average(value.presences, 1),
      }),
    );

    const totalGenderCount = Array.from(globalGenderCounts.values()).reduce(
      (acc, value) => acc + value,
      0,
    );

    const repeatCustomers = Array.from(userEventsMap.values()).filter(
      (eventsPerUser) => eventsPerUser.size > 1,
    ).length;
    const uniqueCustomers = userEventsMap.size;

    return {
      venue_id: venueId,
      venue_name: venue.name,
      generated_at: new Date().toISOString(),
      overview: {
        totalRevenue: this.round(overviewTotals.totalRevenue, 2),
        totalEntries: overviewTotals.totalEntries,
        totalReservations: overviewTotals.totalReservations,
        totalTableGuests: overviewTotals.totalTableGuests,
        totalPresences: overviewTotals.totalPresences,
        avgRevenuePerEvent:
          eventSummaries.length > 0
            ? this.round(overviewTotals.totalRevenue / eventSummaries.length, 2)
            : 0,
        avgRevenuePerPresence:
          overviewTotals.totalPresences > 0
            ? this.round(
                overviewTotals.totalRevenue / overviewTotals.totalPresences,
                2,
              )
            : 0,
        avgStayMinutes:
          stayAggregate._avg.duration_ms == null
            ? 0
            : this.round(this.decimalToNumber(stayAggregate._avg.duration_ms) / 60000, 1),
      },
      audience: {
        uniqueCustomers,
        repeatCustomers,
        repeatRate:
          uniqueCustomers > 0
            ? this.round((repeatCustomers / uniqueCustomers) * 100, 1)
            : 0,
        averageAge:
          audienceAgeValues.length > 0 ? this.average(audienceAgeValues, 1) : null,
        genderSplit: this.distributionFromMap(globalGenderCounts, totalGenderCount),
        ageBuckets: this.distributionFromMap(ageBucketCounts).filter(
          (item) => item.count > 0,
        ),
        ageEntryWindows: Array.from(ageEntryWindowMap.entries())
          .map(([label, value]) => ({
            label,
            count: value.count,
            avgEntryHour: this.averageHourLabel(value.hours),
            peakEntryHour: this.topCountItem(value.hourCounts)?.label ?? null,
          }))
          .sort((a, b) => b.count - a.count),
      },
      bookings: {
        avgLeadDays: this.average(leadDays, 1),
        bestEventWeekday: this.topCountItem(bookingByEventWeekday),
        bestBookingWeekday: this.topCountItem(bookingByCreatedWeekday),
        bestBookingHour: this.topCountItem(bookingByHour),
        busiestEntryHour: this.topCountItem(entryHourCounts),
        byEventWeekday: this.distributionFromMap(bookingByEventWeekday),
        byBookingWeekday: this.distributionFromMap(bookingByCreatedWeekday),
        byBookingHour: this.distributionFromMap(bookingByHour),
        leadTimeBuckets: this.distributionFromMap(leadTimeBuckets),
      },
      revenue: {
        channelMix: [
          { label: 'Ingressi', value: this.round(overviewTotals.entriesRevenue, 2) },
          { label: 'Bar', value: this.round(overviewTotals.barRevenue, 2) },
          { label: 'Guardaroba', value: this.round(overviewTotals.cloakroomRevenue, 2) },
          { label: 'Tavoli', value: this.round(overviewTotals.tablesRevenue, 2) },
        ]
          .map((item) => ({
            ...item,
            share:
              overviewTotals.totalRevenue > 0
                ? this.round((item.value / overviewTotals.totalRevenue) * 100, 1)
                : 0,
          }))
          .sort((a, b) => b.value - a.value),
        averagePerClosedEvent: {
          revenue: this.average(comparisonBase.map((event) => event.totalRevenue), 2),
          entriesRevenue: this.average(
            comparisonBase.map((event) => event.entriesRevenue),
            2,
          ),
          barRevenue: this.average(comparisonBase.map((event) => event.barRevenue), 2),
          cloakroomRevenue: this.average(
            comparisonBase.map((event) => event.cloakroomRevenue),
            2,
          ),
          tablesRevenue: this.average(
            comparisonBase.map((event) => event.tablesRevenue),
            2,
          ),
          entries: this.average(comparisonBase.map((event) => event.totalEntries), 1),
          presences: this.average(
            comparisonBase.map((event) => event.totalPresences),
            1,
          ),
        },
        weekdayBenchmarks,
      },
      historical: {
        totalEvents: eventSummaries.length,
        closedEvents: closedEvents.length,
        topEvent:
          [...eventSummaries].sort((a, b) => b.totalRevenue - a.totalRevenue)[0] ?? null,
      },
      events: eventSummaries,
    };
  }
}
