import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  DiscountType,
  EventAccessMode,
  EventStatus,
  Gender,
  Prisma,
  PromoStatus,
  events,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseStorageService } from '../common/storage/supabase-storage.service';
import { ExpoPushService } from '../common/push/expo-push.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

export type EventStats = {
  event_id: string;
  total_entries: number;
  total_entries_revenue: number;
  total_bar: number;
  total_cloakroom: number;
  total_tables: number;
  last_updated: Date;
};

type EventStatusSyncCandidate = {
  id: string;
  date: Date | null;
  start_time: Date | null;
  end_time: Date | null;
  status: EventStatus | null;
};

type TablePricingOverrideInput = {
  venue_table_zone_id: string;
  per_testa?: number | string;
  costo_minimo?: number | string;
  persone_max?: number;
};

type UploadedPosterFile = {
  originalname?: string;
  mimetype?: string;
  buffer: Buffer;
};

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly expoPush: ExpoPushService,
  ) {}

  private isTransientPrismaConnectivityError(error: unknown): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return (
        error.code === 'P1001' ||
        error.code === 'P1002' ||
        error.code === 'P1017'
      );
    }

    if (error instanceof Prisma.PrismaClientInitializationError) {
      return true;
    }

    if (error instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = String(error.message || '').toLowerCase();
      return (
        msg.includes('server has closed the connection') ||
        msg.includes('connection reset') ||
        msg.includes('connection closed') ||
        msg.includes("can't reach database server")
      );
    }

    return false;
  }

  private async runPrismaQueryWithRetry<T>(
    operationName: string,
    query: () => Promise<T>,
  ): Promise<T> {
    try {
      return await query();
    } catch (error) {
      if (!this.isTransientPrismaConnectivityError(error)) {
        throw error;
      }

      this.logger.warn(
        `${operationName} failed due to temporary database connectivity issue. Retrying once.`,
      );

      try {
        return await query();
      } catch (retryError) {
        if (!this.isTransientPrismaConnectivityError(retryError)) {
          throw retryError;
        }

        this.logger.error(
          `${operationName} failed after retry: temporary database connectivity issue persists.`,
        );
        throw new ServiceUnavailableException(
          'Servizio eventi temporaneamente non disponibile. Riprova tra pochi secondi.',
        );
      }
    }
  }

  private getEventsTimeZone(): string {
    // Events times (date + @db.Time) are intended as local venue time.
    // Defaulting to Europe/Rome keeps behavior aligned with production expectations.
    return process.env.EVENTS_TIMEZONE || 'Europe/Rome';
  }

  private getTimeZoneOffsetMs(timeZone: string, instant: Date): number {
    // Returns offset where: localTime = utcTime + offset
    // Uses Intl to derive the local wall-clock components for the given instant.
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const parts = dtf.formatToParts(instant);
    const map = new Map(parts.map((p) => [p.type, p.value]));
    const year = Number(map.get('year'));
    const month = Number(map.get('month'));
    const day = Number(map.get('day'));
    const hour = Number(map.get('hour'));
    const minute = Number(map.get('minute'));
    const second = Number(map.get('second'));

    const localAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    return localAsUtcMs - instant.getTime();
  }

  private zonedDateTimeToUtcMs(params: {
    timeZone: string;
    year: number;
    month: number; // 1-12
    day: number; // 1-31
    hour: number;
    minute: number;
    second?: number;
  }): number {
    const baseUtc = Date.UTC(
      params.year,
      params.month - 1,
      params.day,
      params.hour,
      params.minute,
      params.second ?? 0,
      0,
    );

    // Two-pass conversion to handle DST boundaries correctly.
    const guess = new Date(baseUtc);
    const offset1 = this.getTimeZoneOffsetMs(params.timeZone, guess);
    const utc1 = baseUtc - offset1;
    const offset2 = this.getTimeZoneOffsetMs(params.timeZone, new Date(utc1));
    return baseUtc - offset2;
  }

  private isDataUrlImage(value?: string | null): boolean {
    return Boolean(
      value && /^data:image\/(png|jpe?g|webp);base64,/i.test(value),
    );
  }

  async uploadEventPoster(file?: UploadedPosterFile) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('file must be an image');
    }

    const ext = (() => {
      const m = /\.(png|jpe?g|webp)$/i.exec(file.originalname || '');
      if (m) return m[1].toLowerCase();
      if (file.mimetype === 'image/png') return 'png';
      if (file.mimetype === 'image/webp') return 'webp';
      return 'jpg';
    })();

    const { pathPromise } = this.storage.uploadEventPosterFromBuffer({
      buffer: file.buffer,
      contentType: file.mimetype,
      ext,
    });

    const path = await pathPromise;
    return { path };
  }

  async createEventPosterSignedUpload(params?: {
    ext?: string;
    contentType?: string;
  }) {
    return this.storage.createSignedUploadForEventPoster({
      ext: params?.ext,
      contentType: params?.contentType,
    });
  }

  private isDebugEventsEnabled(): boolean {
    return process.env.DEBUG_EVENTS === '1';
  }

  private computedStatusExpr() {
    // Delegates computed status (including cross-midnight windows) to the DB.
    // Returns a Postgres "EventStatus" enum.
    return Prisma.sql`public.compute_event_status(e."date", e."start_time", e."end_time", e."status")`;
  }

  private async listEventIdsByComputedStatus(params: {
    venueId?: string;
    date?: string; // YYYY-MM-DD
    // Exactly one of these two is expected: `status` for an exact match (explicit
    // ?status=LIVE/CLOSED), `excludeStatus` to filter a status out (the default public feed
    // excludes CLOSED - see listEvents/listEventsPaginated).
    status?: EventStatus;
    excludeStatus?: EventStatus;
    skip?: number;
    take?: number;
    withTotal?: boolean;
  }): Promise<{ ids: string[]; total?: number }> {
    const venueId = params.venueId ?? null;
    const date = params.date ?? null;
    const skip = params.skip ?? 0;
    const take = params.take;
    const computed = this.computedStatusExpr();

    const statusCondition = params.status
      ? Prisma.sql`(${computed}) = (${params.status}::"EventStatus")`
      : params.excludeStatus
        ? Prisma.sql`(${computed}) <> (${params.excludeStatus}::"EventStatus")`
        : Prisma.sql`TRUE`;

    const whereBase = Prisma.sql`
      FROM "events" e
      WHERE (${venueId}::uuid IS NULL OR e."venue_id" = ${venueId}::uuid)
        AND (${date}::date IS NULL OR e."date" = ${date}::date)
        AND ${statusCondition}
    `;

    let total: number | undefined;
    if (params.withTotal) {
      const rows = await this.runPrismaQueryWithRetry(
        'events.listEventIdsByComputedStatus.count',
        () =>
          this.prisma.$queryRaw<Array<{ total: number }>>(
            Prisma.sql`SELECT COUNT(*)::int AS total ${whereBase}`,
          ),
      );
      total = rows?.[0]?.total ?? 0;
    }

    const limitOffset =
      typeof take === 'number'
        ? Prisma.sql` LIMIT ${take} OFFSET ${skip}`
        : Prisma.empty;

    const idRows = await this.runPrismaQueryWithRetry(
      'events.listEventIdsByComputedStatus.ids',
      () =>
        this.prisma.$queryRaw<Array<{ id: string }>>(
          Prisma.sql`
            SELECT e."id"
            ${whereBase}
            ORDER BY e."date" ASC, e."start_time" ASC NULLS LAST
            ${limitOffset}
          `,
        ),
    );

    return { ids: idRows.map((r) => r.id), total };
  }

  private computeEffectiveStatus(e: {
    date?: Date | null;
    start_time?: Date | null;
    end_time?: Date | null;
    status?: EventStatus | null;
  }): EventStatus {
    const fallback = e.status ?? EventStatus.DRAFT;
    if (!e?.date || !e?.start_time || !e?.end_time) return fallback;

    const timeZone = this.getEventsTimeZone();

    // Date is @db.Date: use UTC date parts to avoid timezone drift for the calendar day.
    // start/end are @db.Time: use UTC time parts to extract the raw time value.
    const year = e.date.getUTCFullYear();
    const month = e.date.getUTCMonth() + 1;
    const day = e.date.getUTCDate();

    const sh = e.start_time.getUTCHours();
    const sm = e.start_time.getUTCMinutes();
    const eh = e.end_time.getUTCHours();
    const em = e.end_time.getUTCMinutes();

    const startMs = this.zonedDateTimeToUtcMs({
      timeZone,
      year,
      month,
      day,
      hour: sh,
      minute: sm,
    });

    let endMs = this.zonedDateTimeToUtcMs({
      timeZone,
      year,
      month,
      day,
      hour: eh,
      minute: em,
    });

    // Events can end after midnight (e.g. Saturday 23:00 -> Sunday 05:00)
    if (endMs <= startMs) endMs += 24 * 60 * 60 * 1000;

    const nowMs = Date.now();
    if (nowMs < startMs) return EventStatus.DRAFT;
    if (nowMs >= startMs && nowMs < endMs) {
      return EventStatus.LIVE;
    }
    return EventStatus.CLOSED;
  }

  private async syncEventStatusIfNeeded(e: {
    id?: string;
    date?: Date | null;
    start_time?: Date | null;
    end_time?: Date | null;
    status?: EventStatus | null;
  }): Promise<void> {
    if (!e?.id) return;
    if (!e?.date || !e?.start_time || !e?.end_time) return;

    const effective = this.computeEffectiveStatus(e);
    const current = e.status ?? EventStatus.DRAFT;
    if (effective === current) return;

    // Best-effort: keep DB status aligned for all consumers.
    try {
      await this.prisma.events.update({
        where: { id: e.id },
        data: { status: effective },
      });
    } catch {
      // ignore
    }
  }

  // Batched variant of syncEventStatusIfNeeded for list endpoints: instead of one UPDATE
  // per drifted row (N writes on every GET), group ids by target status and issue at most
  // one updateMany per distinct target status (in practice at most 2: LIVE, CLOSED).
  private async syncEventStatusesIfNeeded(
    list: EventStatusSyncCandidate[],
  ): Promise<void> {
    const idsByStatus = new Map<EventStatus, string[]>();

    for (const e of list) {
      if (!e?.id || !e?.date || !e?.start_time || !e?.end_time) continue;
      const effective = this.computeEffectiveStatus(e);
      const current = e.status ?? EventStatus.DRAFT;
      if (effective === current) continue;

      const ids = idsByStatus.get(effective) ?? [];
      ids.push(e.id);
      idsByStatus.set(effective, ids);
    }

    if (idsByStatus.size === 0) return;

    try {
      await Promise.all(
        Array.from(idsByStatus.entries()).map(([status, ids]) =>
          this.prisma.events.updateMany({
            where: { id: { in: ids } },
            data: { status },
          }),
        ),
      );
    } catch {
      // Best-effort: status sync must not break the read path.
    }
  }

  private normalizeStatus(status?: string): EventStatus | undefined {
    if (!status) return undefined;
    const normalized = status.toUpperCase();
    const allowed = new Set<string>(Object.values(EventStatus));
    if (!allowed.has(normalized)) {
      throw new BadRequestException(
        `Invalid status. Allowed: ${Array.from(allowed).join(', ')}`,
      );
    }
    return normalized as EventStatus;
  }

  private parseDate(value?: string): Date | undefined {
    if (!value) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Invalid date format');
    }
    return parsed;
  }

  private parseTime(value?: string): Date | undefined {
    if (!value) return undefined;
    // Accept either full ISO or HH:MM/HH:MM:SS.
    // IMPORTANT: for @db.Time fields we want stable time-only storage (no timezone drift).
    if (value.includes('T')) {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('Invalid time format');
      }
      return parsed;
    }

    const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(value);
    if (!m) throw new BadRequestException('Invalid time format');
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    const ss = m[3] ? parseInt(m[3], 10) : 0;
    return new Date(Date.UTC(1970, 0, 1, hh, mm, ss, 0));
  }

  private pad2(n: number) {
    return String(n).padStart(2, '0');
  }

  private formatDateOnly(date: Date): string {
    // YYYY-MM-DD from UTC components to avoid timezone drift
    return `${date.getUTCFullYear()}-${this.pad2(date.getUTCMonth() + 1)}-${this.pad2(date.getUTCDate())}`;
  }

  private formatTimeOnly(time?: Date | null): string | undefined {
    if (!time) return undefined;
    // For @db.Time Prisma returns a Date; use UTC components to avoid timezone offset changes
    return `${this.pad2(time.getUTCHours())}:${this.pad2(time.getUTCMinutes())}`;
  }

  // Serialization intentionally reshapes Prisma types (date/time-only, decimals).
  // Keep it centralized and suppress strict no-unsafe rules locally.
  /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */
  private serializeEvent(e: any) {
    if (!e) return e;

    const effectiveStatus = this.computeEffectiveStatus(e);

    return {
      ...e,
      is_featured: Boolean(e.is_featured),
      status: effectiveStatus,
      date: e.date ? this.formatDateOnly(e.date) : e.date,
      start_time: this.formatTimeOnly(e.start_time),
      end_time: this.formatTimeOnly(e.end_time),
      entry_prices: Array.isArray(e.entry_prices)
        ? e.entry_prices.map((p: any) => ({
            ...p,
            start_time: this.formatTimeOnly(p.start_time),
            end_time: this.formatTimeOnly(p.end_time),
            price: this.decimalToNumber(p.price),
          }))
        : e.entry_prices,
      promos: Array.isArray(e.promos)
        ? e.promos.map((p: any) => ({
            ...p,
            discount_value: this.decimalToNumber(p.discount_value),
          }))
        : e.promos,
      venue: e.venue
        ? {
            ...e.venue,
            latitude:
              e.venue.latitude === null || e.venue.latitude === undefined
                ? null
                : this.decimalToNumber(e.venue.latitude),
            longitude:
              e.venue.longitude === null || e.venue.longitude === undefined
                ? null
                : this.decimalToNumber(e.venue.longitude),
            cloakroom_unit_price:
              e.venue.cloakroom_unit_price === null ||
              e.venue.cloakroom_unit_price === undefined
                ? null
                : this.decimalToNumber(e.venue.cloakroom_unit_price),
            contract_monthly_fee:
              e.venue.contract_monthly_fee === null ||
              e.venue.contract_monthly_fee === undefined
                ? null
                : this.decimalToNumber(e.venue.contract_monthly_fee),
          }
        : e.venue,
      presale_price:
        e.presale_price === null || e.presale_price === undefined
          ? null
          : this.decimalToNumber(e.presale_price),
    };
  }
  /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */

  private hasTablePricingOverride(row: {
    per_testa_override?: Prisma.Decimal | null;
    costo_minimo_override?: Prisma.Decimal | null;
    persone_max_override?: number | null;
  }) {
    return (
      (row.per_testa_override !== null &&
        row.per_testa_override !== undefined) ||
      (row.costo_minimo_override !== null &&
        row.costo_minimo_override !== undefined) ||
      (row.persone_max_override !== null &&
        row.persone_max_override !== undefined)
    );
  }

  /**
   * Fetches venue_tables, event_tables overrides, the venue's floor plan (+landmarks) and
   * all its table zones, then derives both the resolved table pricing list and the floor
   * plan from that shared data in memory. Replaces two previously-separate methods that each
   * independently re-fetched venue_tables and event_tables (duplicated queries).
   *
   * Deliberately plain `Promise.all` rather than `$transaction([...])`: these 4 reads are
   * read-only and don't need snapshot isolation with each other (same tolerance the original
   * two-method version already had, since it ran as two independent transactions). A Prisma
   * batch `$transaction` holds one connection and runs its queries sequentially over it (one
   * BEGIN/COMMIT, not concurrent execution) - on a pooled remote DB the per-query network RTT
   * dominates, so 4 queries in one transaction cost ~4x one query. `Promise.all` lets each
   * query grab its own pooled connection and run concurrently, costing ~1x one query instead.
   *
   * Filtered through the `venue.events` relation keyed on `eventId` alone (not a `venueId`
   * param) so this can run in the *same* `Promise.all` as the main event fetch in `getEvent`
   * instead of waiting for it to resolve `venue_id` first - see the call site.
   */
  // Physical tables no longer exist in the booking pipeline - zones (`venue_table_zones`)
  // are the addressable unit for both pricing overrides and floor-plan positioning (zones
  // carry their own floor_x/y/w/h, same as venue_tables used to).
  private async loadEventPricingAndFloorPlanSource(eventId: string) {
    const prismaAny = this.prisma as any;
    const venueByEvent = { venue: { events: { some: { id: eventId } } } };

    const [venueZones, eventTableOverrides, floorPlan] = await Promise.all([
      this.prisma.venue_table_zones.findMany({
        where: venueByEvent,
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          color: true,
          booking_policy: true,
          per_testa: true,
          costo_minimo: true,
          persone_max: true,
          floor_x: true,
          floor_y: true,
          floor_w: true,
          floor_h: true,
          sort_order: true,
          is_active: true,
        },
      }),
      this.prisma.event_tables.findMany({
        where: { event_id: eventId },
        select: {
          id: true,
          venue_table_zone_id: true,
          per_testa_override: true,
          costo_minimo_override: true,
          persone_max_override: true,
        },
      }),
      prismaAny.venue_floor_plans.findFirst({
        where: venueByEvent,
        select: {
          id: true,
          venue_id: true,
          background_image: true,
          canvas_width: true,
          canvas_height: true,
          grid_size: true,
          show_grid: true,
          landmarks: {
            orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
            select: {
              id: true,
              type: true,
              label: true,
              x: true,
              y: true,
              width: true,
              height: true,
              rotation: true,
              color: true,
              metadata: true,
              sort_order: true,
            },
          },
        },
      }),
    ]);

    return { venueZones, eventTableOverrides, floorPlan };
  }

  private buildResolvedTablePricingFromSource(
    venueZones: Array<{
      id: string;
      name: string;
      per_testa: Prisma.Decimal | null;
      costo_minimo: Prisma.Decimal | null;
      persone_max: number | null;
    }>,
    eventTableOverrides: Array<{
      id: string;
      venue_table_zone_id: string;
      per_testa_override: Prisma.Decimal | null;
      costo_minimo_override: Prisma.Decimal | null;
      persone_max_override: number | null;
    }>,
  ) {
    const overrideByZoneId = new Map(
      eventTableOverrides.map((row) => [row.venue_table_zone_id, row]),
    );
    const hasExplicitSelection = eventTableOverrides.length > 0;
    const selectedZones = hasExplicitSelection
      ? venueZones.filter((zone) => overrideByZoneId.has(zone.id))
      : venueZones;

    return selectedZones.map((zone) => {
      const override = overrideByZoneId.get(zone.id);
      const basePerTesta =
        zone.per_testa === null || zone.per_testa === undefined
          ? null
          : this.decimalToNumber(zone.per_testa);
      const baseCostoMinimo =
        zone.costo_minimo === null || zone.costo_minimo === undefined
          ? null
          : this.decimalToNumber(zone.costo_minimo);
      const overridePerTesta =
        override?.per_testa_override === null ||
        override?.per_testa_override === undefined
          ? null
          : this.decimalToNumber(override.per_testa_override);
      const overrideCostoMinimo =
        override?.costo_minimo_override === null ||
        override?.costo_minimo_override === undefined
          ? null
          : this.decimalToNumber(override.costo_minimo_override);
      const overridePersoneMax =
        override?.persone_max_override === null ||
        override?.persone_max_override === undefined
          ? null
          : Number(override.persone_max_override);
      const hasOverride = override
        ? this.hasTablePricingOverride(override)
        : false;

      return {
        event_table_id: override?.id,
        venue_table_zone_id: zone.id,
        nome: zone.name,
        label: zone.name,
        per_testa: hasOverride ? overridePerTesta : basePerTesta,
        costo_minimo: hasOverride ? overrideCostoMinimo : baseCostoMinimo,
        persone_max: hasOverride
          ? overridePersoneMax
          : (zone.persone_max ?? null),
        base_per_testa: basePerTesta,
        base_costo_minimo: baseCostoMinimo,
        base_persone_max:
          zone.persone_max === null || zone.persone_max === undefined
            ? null
            : Number(zone.persone_max),
        override_per_testa: overridePerTesta,
        override_costo_minimo: overrideCostoMinimo,
        override_persone_max: overridePersoneMax,
        has_override: hasOverride,
      };
    });
  }

  private buildDerivedFloorPlanFromSource(
    floorPlan: any,
    venueZones: any[],
    eventTableOverrides: Array<{
      id: string;
      venue_table_zone_id: string;
      per_testa_override: Prisma.Decimal | null;
      costo_minimo_override: Prisma.Decimal | null;
      persone_max_override: number | null;
    }>,
  ) {
    type EventTableOverrideRow = {
      id: string;
      venue_table_zone_id: string;
      per_testa_override: Prisma.Decimal | null;
      costo_minimo_override: Prisma.Decimal | null;
      persone_max_override: number | null;
    };

    if (!floorPlan) return null;

    const overrideByZoneId = new Map<string, EventTableOverrideRow>(
      (eventTableOverrides as EventTableOverrideRow[]).map((row) => [
        row.venue_table_zone_id,
        row,
      ]),
    );
    const hasExplicitSelection = eventTableOverrides.length > 0;
    const selectedZones = hasExplicitSelection
      ? venueZones.filter((zone) => overrideByZoneId.has(zone.id))
      : venueZones;

    const mappedZones = selectedZones
      .filter((zone) => zone.is_active)
      .map((zone) => {
        const override = overrideByZoneId.get(zone.id);

        const basePerTesta =
          zone.per_testa === null || zone.per_testa === undefined
            ? null
            : this.decimalToNumber(zone.per_testa);
        const baseCostoMinimo =
          zone.costo_minimo === null || zone.costo_minimo === undefined
            ? null
            : this.decimalToNumber(zone.costo_minimo);
        const overridePerTesta =
          override?.per_testa_override === null ||
          override?.per_testa_override === undefined
            ? null
            : this.decimalToNumber(override.per_testa_override);
        const overrideCostoMinimo =
          override?.costo_minimo_override === null ||
          override?.costo_minimo_override === undefined
            ? null
            : this.decimalToNumber(override.costo_minimo_override);
        const overridePersoneMax =
          override?.persone_max_override === null ||
          override?.persone_max_override === undefined
            ? null
            : Number(override.persone_max_override);
        const hasOverride = override
          ? this.hasTablePricingOverride(override)
          : false;

        return {
          id: zone.id,
          event_table_id: override?.id,
          venue_table_zone_id: zone.id,
          zone_name: zone.name,
          booking_policy: zone.booking_policy ?? 'exclusive',
          zone_color: zone.color ?? null,
          nome: zone.name,
          per_testa: hasOverride ? overridePerTesta : basePerTesta,
          costo_minimo: hasOverride ? overrideCostoMinimo : baseCostoMinimo,
          persone_max: hasOverride
            ? overridePersoneMax
            : zone.persone_max === null || zone.persone_max === undefined
              ? null
              : Number(zone.persone_max),
          has_override: hasOverride,
          floor_x:
            zone.floor_x === null || zone.floor_x === undefined
              ? null
              : this.decimalToNumber(zone.floor_x),
          floor_y:
            zone.floor_y === null || zone.floor_y === undefined
              ? null
              : this.decimalToNumber(zone.floor_y),
          floor_w:
            zone.floor_w === null || zone.floor_w === undefined
              ? null
              : this.decimalToNumber(zone.floor_w),
          floor_h:
            zone.floor_h === null || zone.floor_h === undefined
              ? null
              : this.decimalToNumber(zone.floor_h),
          floor_shape: 'rectangle',
          floor_rotation: 0,
          layout_order: zone.sort_order,
        };
      });

    return {
      id: floorPlan.id,
      venue_id: floorPlan.venue_id,
      background_image: floorPlan.background_image,
      canvas_width: this.decimalToNumber(floorPlan.canvas_width),
      canvas_height: this.decimalToNumber(floorPlan.canvas_height),
      grid_size: this.decimalToNumber(floorPlan.grid_size),
      show_grid: floorPlan.show_grid,
      landmarks: floorPlan.landmarks.map((landmark) => ({
        id: landmark.id,
        type: landmark.type,
        label: landmark.label,
        x: this.decimalToNumber(landmark.x),
        y: this.decimalToNumber(landmark.y),
        width: this.decimalToNumber(landmark.width),
        height: this.decimalToNumber(landmark.height),
        rotation: this.decimalToNumber(landmark.rotation),
        color: landmark.color,
        metadata: landmark.metadata,
        sort_order: landmark.sort_order,
      })),
      tables: mappedZones,
    };
  }

  /** Combines an already-fetched event with a `loadEventPricingAndFloorPlanSource` result. */
  private serializeEventWithPricingSource(
    e: any,
    source: {
      venueZones: any[];
      eventTableOverrides: any[];
      floorPlan: any;
    },
  ) {
    const serialized = this.serializeEvent(e);
    if (!e?.id || !e?.venue_id) {
      return { ...serialized, table_pricing: [], floor_plan: null };
    }

    const { venueZones, eventTableOverrides, floorPlan } = source;

    const tablePricing = this.buildResolvedTablePricingFromSource(
      venueZones,
      eventTableOverrides,
    );
    const derivedFloorPlan = this.buildDerivedFloorPlanFromSource(
      floorPlan,
      venueZones,
      eventTableOverrides,
    );

    return {
      ...serialized,
      table_pricing: tablePricing,
      floor_plan: derivedFloorPlan,
    };
  }

  private normalizeGender(gender?: string): Gender | undefined {
    if (!gender) return undefined;
    const normalized = gender.toUpperCase();
    const allowed = new Set<string>(Object.values(Gender));
    if (!allowed.has(normalized)) {
      throw new BadRequestException(
        `Invalid gender. Allowed: ${Array.from(allowed).join(', ')}`,
      );
    }
    return normalized as Gender;
  }

  private normalizeDiscountType(type?: string): DiscountType | undefined {
    if (!type) return undefined;
    const normalized = type.toLowerCase();
    const allowed = new Set<string>(Object.values(DiscountType));
    if (!allowed.has(normalized)) {
      throw new BadRequestException(
        `Invalid discount_type. Allowed: ${Array.from(allowed).join(', ')}`,
      );
    }
    return normalized as DiscountType;
  }

  private normalizePromoStatus(status?: string): PromoStatus | undefined {
    if (!status) return undefined;
    const normalized = status.toLowerCase();
    const allowed = new Set<string>(Object.values(PromoStatus));
    if (!allowed.has(normalized)) {
      throw new BadRequestException(
        `Invalid promo status. Allowed: ${Array.from(allowed).join(', ')}`,
      );
    }
    return normalized as PromoStatus;
  }

  private normalizeAccessMode(mode?: string): EventAccessMode | undefined {
    if (!mode) return undefined;
    const normalized = mode.toUpperCase();
    const allowed = new Set<string>(Object.values(EventAccessMode));
    if (!allowed.has(normalized)) {
      throw new BadRequestException(
        `Invalid access_mode. Allowed: ${Array.from(allowed).join(', ')}`,
      );
    }
    return normalized as EventAccessMode;
  }

  private normalizeCurrency(currency?: string): string | undefined {
    if (!currency) return undefined;
    const normalized = currency.trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(normalized)) {
      throw new BadRequestException('Invalid presale_currency (ISO 4217)');
    }
    return normalized;
  }

  private parsePositiveInt(
    value: number | string | null | undefined,
    field: string,
  ): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const n = typeof value === 'string' ? Number(value) : value;
    if (!Number.isInteger(n) || n < 1) {
      throw new BadRequestException(`${field} must be an integer >= 1`);
    }
    return n;
  }

  private parsePrice(value: number | string): Prisma.Decimal {
    const asNumber = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(asNumber)) {
      throw new BadRequestException('Invalid price value');
    }
    return new Prisma.Decimal(asNumber);
  }

  private parseOptionalPrice(
    value: number | string | null | undefined,
  ): Prisma.Decimal | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    return this.parsePrice(value);
  }

  private normalizeTablePricingInput(
    tablePricing: TablePricingOverrideInput[] | undefined,
  ) {
    return (tablePricing ?? []).map((row) => {
      const venue_table_zone_id = String(row?.venue_table_zone_id ?? '').trim();
      if (!venue_table_zone_id) {
        throw new BadRequestException(
          'table_pricing.venue_table_zone_id is required',
        );
      }

      const per_testa = this.parseOptionalPrice(row.per_testa);
      const costo_minimo = this.parseOptionalPrice(row.costo_minimo);
      const persone_max = this.parsePositiveInt(
        row.persone_max,
        'table_pricing.persone_max',
      );

      return {
        venue_table_zone_id,
        per_testa,
        costo_minimo,
        persone_max,
      };
    });
  }

  private async applyTablePricingOverrides(
    tx: Prisma.TransactionClient,
    params: {
      eventId: string;
      venueId: string;
      tablePricing: TablePricingOverrideInput[] | undefined;
      replaceExisting: boolean;
    },
  ) {
    const normalizedRows = this.normalizeTablePricingInput(params.tablePricing);
    const uniqueIds = Array.from(
      new Set(normalizedRows.map((row) => row.venue_table_zone_id)),
    );
    const uniqueIdSet = new Set(uniqueIds);

    if (uniqueIds.length !== normalizedRows.length) {
      throw new BadRequestException(
        'table_pricing contains duplicate venue_table_zone_id values',
      );
    }

    if (uniqueIds.length > 0) {
      const venueZones = await tx.venue_table_zones.findMany({
        where: {
          venue_id: params.venueId,
          id: { in: uniqueIds },
        },
        select: { id: true },
      });

      if (venueZones.length !== uniqueIds.length) {
        throw new BadRequestException(
          'One or more table_pricing rows do not belong to the selected venue',
        );
      }
    }

    const existingRows = await tx.event_tables.findMany({
      where: {
        event_id: params.eventId,
      },
      select: {
        id: true,
        venue_table_zone_id: true,
        prenotati: true,
        entrati: true,
        confermato: true,
        _count: {
          select: {
            table_sales: true,
          },
        },
      },
    });

    if (params.replaceExisting) {
      const rowsToRemove = existingRows.filter(
        (row) => !uniqueIdSet.has(row.venue_table_zone_id),
      );

      const blockedRow = rowsToRemove.find(
        (row) =>
          Number(row.prenotati ?? 0) > 0 ||
          Number(row.entrati ?? 0) > 0 ||
          Boolean(row.confermato) ||
          Number(row._count.table_sales ?? 0) > 0,
      );

      if (blockedRow) {
        throw new BadRequestException(
          'Cannot remove a table zone that already has bookings, check-ins, confirmations, or sales',
        );
      }

      if (rowsToRemove.length) {
        await tx.event_tables.deleteMany({
          where: {
            id: { in: rowsToRemove.map((row) => row.id) },
          },
        });
      }
    }

    if (!normalizedRows.length) return;

    const existingByZoneId = new Map(
      existingRows
        .filter((row) => uniqueIdSet.has(row.venue_table_zone_id))
        .map((row) => [row.venue_table_zone_id, row]),
    );

    for (const row of normalizedRows) {
      const data = {
        per_testa_override: row.per_testa ?? null,
        costo_minimo_override: row.costo_minimo ?? null,
        persone_max_override: row.persone_max ?? null,
      };
      const existing = existingByZoneId.get(row.venue_table_zone_id);

      if (existing) {
        await tx.event_tables.update({
          where: { id: existing.id },
          data,
        });
        continue;
      }

      await tx.event_tables.create({
        data: {
          event_id: params.eventId,
          venue_table_zone_id: row.venue_table_zone_id,
          stato: 'libero',
          prenotati: 0,
          entrati: 0,
          pagato_totale: new Prisma.Decimal(0),
          ...data,
        },
      });
    }
  }

  private decimalToNumber(value?: Prisma.Decimal | null): number {
    return value ? Number(value) : 0;
  }

  async listEvents(filters?: {
    venue_id?: string;
    status?: string;
    date?: string;
  }): Promise<events[]> {
    const where: Prisma.eventsWhereInput = {};
    if (filters?.venue_id) where.venue_id = filters.venue_id;
    const requestedStatus = filters?.status
      ? this.normalizeStatus(filters.status)
      : undefined;
    // LIVE/CLOSED are computed from time window, so we cannot rely on DB status.
    if (requestedStatus === EventStatus.DRAFT) where.status = requestedStatus;
    if (filters?.date) where.date = this.parseDate(filters.date);

    // Any request that isn't explicitly asking for DRAFT (persisted DB status) goes through
    // the computed-status path: an explicit ?status=LIVE/CLOSED filters to exactly that, and
    // - importantly - the *default* call with no status filter at all (the public events
    // feed) excludes CLOSED, so past events never show up there without being asked for.
    if (requestedStatus !== EventStatus.DRAFT) {
      const dateOnly = filters?.date ? filters.date : undefined;
      const { ids } = await this.listEventIdsByComputedStatus({
        venueId: filters?.venue_id,
        date: dateOnly,
        ...(requestedStatus
          ? { status: requestedStatus }
          : { excludeStatus: EventStatus.CLOSED }),
      });

      if (!ids.length) return [] as events[];

      const rows = await this.runPrismaQueryWithRetry(
        'events.listEvents.findManyByIds',
        () =>
          this.prisma.events.findMany({
            where: { id: { in: ids } },
            orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
            select: {
              id: true,
              venue_id: true,
              venue: { select: { id: true, name: true, image: true } },
              name: true,
              description: true,
              image: true,
              is_featured: true,
              date: true,
              start_time: true,
              end_time: true,
              status: true,
              created_at: true,
              updated_at: true,
              promos: {
                where: { status: PromoStatus.active },
                orderBy: { created_at: 'desc' },
                take: 3,
                select: {
                  id: true,
                  venue_id: true,
                  event_id: true,
                  title: true,
                  description: true,
                  discount_type: true,
                  discount_value: true,
                  status: true,
                  created_at: true,
                },
              },
            },
          }),
      );

      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      // No write-on-read here anymore: `serializeEvent` below always computes the
      // response's status live from date/time (see computeEffectiveStatus), so a briefly
      // stale DB column doesn't affect what this response shows. Keeping the persisted
      // column in sync is now the cron's job (GET /events/sync-status, wired in
      // vercel.json, runs every 15 min) instead of this endpoint - the highest-traffic,
      // unauthenticated public events list - paying for an UPDATE on every call.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return ordered.map((e) => this.serializeEvent(e)) as any;
    }

    const list = await this.runPrismaQueryWithRetry(
      'events.listEvents.findMany',
      () =>
        this.prisma.events.findMany({
          where,
          orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
          select: {
            id: true,
            venue_id: true,
            venue: { select: { id: true, name: true, image: true } },
            name: true,
            description: true,
            image: true,
            is_featured: true,
            date: true,
            start_time: true,
            end_time: true,
            status: true,
            created_at: true,
            updated_at: true,
            promos: {
              where: { status: PromoStatus.active },
              orderBy: { created_at: 'desc' },
              take: 3,
              select: {
                id: true,
                venue_id: true,
                event_id: true,
                title: true,
                description: true,
                discount_type: true,
                discount_value: true,
                status: true,
                created_at: true,
              },
            },
          },
        }),
    );

    if (this.isDebugEventsEnabled()) {
      console.log('[events.service] listEvents db results', {
        where,
        requestedStatus,
        dbCount: list.length,
        serverNow: new Date().toISOString(),
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      });
    }

    await this.syncEventStatusesIfNeeded(list as EventStatusSyncCandidate[]);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    const serialized = list.map((e) => this.serializeEvent(e));

    if (this.isDebugEventsEnabled()) {
      // Debug sample of computed statuses
      try {
        /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
        const sample = serialized.slice(0, 5).map((e: any) => ({
          id: e?.id,
          name: e?.name,
          date: e?.date,
          start_time: e?.start_time,
          end_time: e?.end_time,
          status: e?.status,
        }));
        /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
        console.log('[events.service] listEvents computed sample', sample);
      } catch {
        // ignore
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return serialized as any;
  }

  async listEventsPaginated(
    page: number,
    pageSize: number,
    filters?: { venue_id?: string; status?: string; date?: string },
  ) {
    const requestedStatus = filters?.status
      ? this.normalizeStatus(filters.status)
      : undefined;

    const take = Math.max(pageSize, 1);
    const skip = (Math.max(page, 1) - 1) * take;

    // Same rule as listEvents: anything other than an explicit ?status=DRAFT goes through the
    // computed-status path, and the default (no status filter - the public feed) excludes
    // CLOSED so past events don't show up unasked.
    if (requestedStatus !== EventStatus.DRAFT) {
      const dateOnly = filters?.date ? filters.date : undefined;
      const { ids, total } = await this.listEventIdsByComputedStatus({
        venueId: filters?.venue_id,
        date: dateOnly,
        ...(requestedStatus
          ? { status: requestedStatus }
          : { excludeStatus: EventStatus.CLOSED }),
        skip,
        take,
        withTotal: true,
      });

      if (!ids.length) {
        return {
          data: [],
          total: total ?? 0,
          page,
          pageSize: take,
          hasMore: false,
        };
      }

      const rows = await this.runPrismaQueryWithRetry(
        'events.listEventsPaginated.findManyByIds',
        () =>
          this.prisma.events.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              venue_id: true,
              venue: { select: { id: true, name: true, image: true } },
              name: true,
              description: true,
              image: true,
              is_featured: true,
              date: true,
              start_time: true,
              end_time: true,
              status: true,
              created_at: true,
              updated_at: true,
              promos: {
                where: { status: PromoStatus.active },
                orderBy: { created_at: 'desc' },
                take: 3,
                select: {
                  id: true,
                  venue_id: true,
                  event_id: true,
                  title: true,
                  description: true,
                  discount_type: true,
                  discount_value: true,
                  status: true,
                  created_at: true,
                },
              },
            },
          }),
      );

      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      await this.syncEventStatusesIfNeeded(
        ordered as EventStatusSyncCandidate[],
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      const pageData = ordered.map((e) => this.serializeEvent(e));

      return {
        data: pageData,
        total: total ?? pageData.length,
        page,
        pageSize: take,
        hasMore: total ? skip + pageData.length < total : false,
      };
    }

    const where: Prisma.eventsWhereInput = {};
    if (filters?.venue_id) where.venue_id = filters.venue_id;
    if (requestedStatus === EventStatus.DRAFT) where.status = requestedStatus;
    if (filters?.date) where.date = this.parseDate(filters.date);

    const [total, data] = await this.runPrismaQueryWithRetry(
      'events.listEventsPaginated.transaction',
      () =>
        this.prisma.$transaction([
          this.prisma.events.count({ where }),
          this.prisma.events.findMany({
            where,
            orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
            skip,
            take,
            select: {
              id: true,
              venue_id: true,
              venue: { select: { id: true, name: true, image: true } },
              name: true,
              description: true,
              image: true,
              is_featured: true,
              date: true,
              start_time: true,
              end_time: true,
              status: true,
              created_at: true,
              updated_at: true,
              promos: {
                where: { status: PromoStatus.active },
                orderBy: { created_at: 'desc' },
                take: 3,
                select: {
                  id: true,
                  venue_id: true,
                  event_id: true,
                  title: true,
                  description: true,
                  discount_type: true,
                  discount_value: true,
                  status: true,
                  created_at: true,
                },
              },
            },
          }),
        ]),
    );

    await this.syncEventStatusesIfNeeded(data as EventStatusSyncCandidate[]);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    const serializedData = data.map((e) => this.serializeEvent(e));

    return {
      data: serializedData,
      total,
      page,
      pageSize: take,
      hasMore: skip + data.length < total,
    };
  }

  async getEvent(id: string) {
    // `promos`/`entry_prices` and the whole table-pricing/floor-plan source are all keyed on
    // `id` alone (the floor-plan source no longer needs `venue_id` resolved from the main
    // event fetch first - see `loadEventPricingAndFloorPlanSource`), so everything this
    // endpoint needs runs in one `Promise.all` instead of the main event fetch completing
    // before the pricing/floor-plan queries could even start.
    const [event, promos, entryPrices, pricingSource] = await Promise.all([
      this.prisma.events.findUnique({
        where: { id },
        include: {
          // Trimmed from `venue: true`: excludes Stripe account/payout status and contract
          // billing fields, which aren't relevant to an event-detail view and shouldn't be
          // sent to every client fetching an event.
          venue: {
            select: {
              id: true,
              name: true,
              city: true,
              address: true,
              description: true,
              image: true,
              latitude: true,
              longitude: true,
              radius_geofence: true,
              cloakroom_unit_price: true,
              bar_price_list: true,
              bottle_price_list: true,
              created_at: true,
              updated_at: true,
            },
          },
        },
      }),
      this.prisma.promos.findMany({ where: { event_id: id } }),
      this.prisma.event_entry_prices.findMany({
        where: { event_id: id },
        orderBy: { created_at: 'asc' },
      }),
      this.loadEventPricingAndFloorPlanSource(id),
    ]);
    if (!event) throw new NotFoundException('Event not found');
    const eventWithRelations = { ...event, promos, entry_prices: entryPrices };
    await this.syncEventStatusIfNeeded(
      eventWithRelations as EventStatusSyncCandidate,
    );
    return this.serializeEventWithPricingSource(
      eventWithRelations,
      pricingSource,
    );
  }

  /** Friends of `userId` who currently hold a non-cancelled reservation (entry or table) for this event. */
  async getFriendsGoing(eventId: string, userId: string) {
    const links = await this.prisma.friendships.findMany({
      where: { user_id: userId },
      select: { friend_id: true },
    });
    const friendIds = links.map((l) => l.friend_id);
    if (friendIds.length === 0) return [];

    const reservations = await this.prisma.reservations.findMany({
      where: {
        event_id: eventId,
        user_id: { in: friendIds },
        status: { not: 'cancelled' },
      },
      select: { user_id: true },
      distinct: ['user_id'],
    });
    const goingIds = reservations.map((r) => r.user_id);
    if (goingIds.length === 0) return [];

    return this.prisma.users.findMany({
      where: { id: { in: goingIds } },
      select: { id: true, username: true, name: true, avatar: true },
    });
  }

  async assertEventBelongsToVenue(eventId: string, venueId: string) {
    const e = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { id: true, venue_id: true },
    });
    if (!e) throw new NotFoundException('Event not found');
    if (e.venue_id !== venueId) throw new ForbiddenException('Forbidden');
  }

  async getEventStats(eventId: string): Promise<EventStats> {
    return this.recalculateEventStats(eventId);
  }

  async createEvent(dto: CreateEventDto) {
    // Status is automatic: clients can only create events as DRAFT/Programmato.
    // LIVE/CLOSED are computed from date + time window.
    const requested = this.normalizeStatus(dto.status);
    const status =
      requested === EventStatus.DRAFT ? requested : EventStatus.DRAFT;
    const date = this.parseDate(dto.date);
    if (!date) {
      throw new BadRequestException('date is required');
    }
    const start_time = this.parseTime(dto.start_time);
    const end_time = this.parseTime(dto.end_time);
    const accessMode =
      this.normalizeAccessMode(dto.access_mode) ?? EventAccessMode.LIST;
    const presalePrice =
      dto.presale_price === undefined || dto.presale_price === null
        ? undefined
        : this.parsePrice(dto.presale_price);
    const presaleCurrency =
      this.normalizeCurrency(dto.presale_currency) ?? 'eur';
    const presaleCapacity = this.parsePositiveInt(
      dto.presale_capacity,
      'presale_capacity',
    );

    if (accessMode === EventAccessMode.PRE_SALE && !presalePrice) {
      throw new BadRequestException(
        'presale_price is required when access_mode is PRE_SALE',
      );
    }

    if (!dto.venue_id) {
      throw new BadRequestException('venue_id is required');
    }

    const entryPricesCreate = (dto.entry_prices ?? []).map((p) => {
      return {
        label: p.label,
        gender: this.normalizeGender(p.gender),
        start_time: this.parseTime(p.start_time),
        end_time: this.parseTime(p.end_time),
        price: this.parsePrice(p.price),
      };
    });

    const promosCreate = (dto.promos ?? []).map((p) => {
      const discountType = this.normalizeDiscountType(p.discount_type);
      if (!discountType) {
        throw new BadRequestException('promo.discount_type is required');
      }

      return {
        venue_id: dto.venue_id!,
        title: p.title,
        description: p.description,
        discount_type: discountType,
        discount_value:
          p.discount_value === undefined || p.discount_value === null
            ? undefined
            : this.parsePrice(p.discount_value),
        status: this.normalizePromoStatus(p.status) ?? PromoStatus.active,
      };
    });

    if (this.isDataUrlImage(dto.image)) {
      throw new BadRequestException(
        'image must be a storage path (upload poster via POST /events/poster/signed or POST /events/poster)',
      );
    }

    const imagePath: string | undefined = dto.image;

    const event = await this.prisma.events.create({
      data: {
        venue_id: dto.venue_id,
        name: dto.name,
        description: dto.description,
        image: imagePath,
        // dto.is_featured only ever reaches here truthy for an admin caller (the controller
        // forces it false for a venue) - so a true value here is always a deliberate manual
        // grant, never something the auto-featured cron should later consider "its own".
        is_featured: dto.is_featured ?? false,
        featured_source: dto.is_featured ? 'manual' : null,
        date,
        start_time,
        end_time,
        status,
        access_mode: accessMode,
        presale_price:
          accessMode === EventAccessMode.PRE_SALE ? presalePrice : null,
        presale_currency: presaleCurrency,
        presale_capacity:
          accessMode === EventAccessMode.PRE_SALE
            ? (presaleCapacity ?? null)
            : null,
        entry_prices: entryPricesCreate.length
          ? { create: entryPricesCreate }
          : undefined,
        promos: promosCreate.length ? { create: promosCreate } : undefined,
      },
    });

    if (dto.table_pricing) {
      await this.applyTablePricingOverrides(this.prisma, {
        eventId: event.id,
        venueId: dto.venue_id,
        tablePricing: dto.table_pricing,
        replaceExisting: false,
      });
    }

    return this.getEvent(event.id);
  }

  async updateEvent(id: string, dto: UpdateEventDto) {
    // Avoid using the serialized DTO for internal checks.
    const existing = await this.prisma.events.findUnique({
      where: { id },
      select: { venue_id: true },
    });
    if (!existing) throw new NotFoundException('Event not found');
    const requested = dto.status ? this.normalizeStatus(dto.status) : undefined;
    const status = requested === EventStatus.DRAFT ? requested : undefined;
    const date = this.parseDate(dto.date);
    const start_time = this.parseTime(dto.start_time);
    const end_time = this.parseTime(dto.end_time);
    const accessMode = this.normalizeAccessMode(dto.access_mode);
    const presalePrice =
      dto.presale_price === undefined || dto.presale_price === null
        ? undefined
        : this.parsePrice(dto.presale_price);
    const presaleCurrency = this.normalizeCurrency(dto.presale_currency);
    const presaleCapacity = this.parsePositiveInt(
      dto.presale_capacity,
      'presale_capacity',
    );

    if (
      accessMode === EventAccessMode.PRE_SALE &&
      dto.presale_price !== null &&
      !presalePrice
    ) {
      throw new BadRequestException(
        'presale_price is required when access_mode is PRE_SALE',
      );
    }

    const venueId = dto.venue_id ?? existing.venue_id;

    if (this.isDataUrlImage(dto.image)) {
      throw new BadRequestException(
        'image must be a storage path (upload poster via POST /events/poster/signed or POST /events/poster)',
      );
    }

    const imagePath: string | undefined = dto.image;

    await this.prisma.$transaction(async (tx) => {
      await tx.events.update({
        where: { id },
        data: {
          venue_id: dto.venue_id,
          name: dto.name,
          description: dto.description,
          image: imagePath,
          // Same reasoning as createEvent(): dto.is_featured only ever arrives here for an
          // admin caller (the controller deletes it from the DTO for a venue), so an
          // explicit value here is always a deliberate manual grant/revoke - stamp
          // featured_source accordingly so the auto-featured cron knows to leave it alone.
          // `undefined` (the field wasn't sent) leaves both columns untouched.
          is_featured:
            dto.is_featured === undefined
              ? undefined
              : Boolean(dto.is_featured),
          featured_source:
            dto.is_featured === undefined
              ? undefined
              : dto.is_featured
                ? 'manual'
                : null,
          date,
          start_time,
          end_time,
          status,
          access_mode: accessMode,
          presale_price:
            dto.presale_price === null
              ? null
              : dto.presale_price !== undefined
                ? presalePrice
                : undefined,
          presale_currency: presaleCurrency,
          presale_capacity:
            dto.presale_capacity === null
              ? null
              : dto.presale_capacity !== undefined
                ? presaleCapacity
                : undefined,
        },
      });

      if (dto.entry_prices) {
        await tx.event_entry_prices.deleteMany({ where: { event_id: id } });
        if (dto.entry_prices.length) {
          await tx.event_entry_prices.createMany({
            data: dto.entry_prices.map((p) => ({
              event_id: id,
              label: p.label,
              gender: this.normalizeGender(p.gender),
              start_time: this.parseTime(p.start_time),
              end_time: this.parseTime(p.end_time),
              price: this.parsePrice(p.price),
            })),
          });
        }
      }

      if (dto.promos) {
        // Replace promos linked to this event
        await tx.promos.deleteMany({ where: { event_id: id } });
        if (dto.promos.length) {
          await tx.promos.createMany({
            data: dto.promos.map((p) => {
              const discountType = this.normalizeDiscountType(p.discount_type);
              if (!discountType) {
                throw new BadRequestException(
                  'promo.discount_type is required',
                );
              }

              return {
                venue_id: venueId,
                event_id: id,
                title: p.title,
                description: p.description,
                discount_type: discountType,
                discount_value:
                  p.discount_value === undefined || p.discount_value === null
                    ? null
                    : this.parsePrice(p.discount_value),
                status:
                  this.normalizePromoStatus(p.status) ?? PromoStatus.active,
              };
            }),
          });
        }
      }

      if (dto.table_pricing !== undefined) {
        await this.applyTablePricingOverrides(tx, {
          eventId: id,
          venueId,
          tablePricing: dto.table_pricing,
          replaceExisting: true,
        });
      }
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.getEvent(id);
  }

  // Marks the event CANCELLED and cancels every non-cancelled reservation tied to it
  // (an UPDATE, unlike deleteEvent's DELETE - this is what keeps history intact and is
  // what avoids the ticket_orders FK issue deleteEvent has). Notifies every affected
  // reservation holder with a best-effort push; a failed push never blocks the
  // cancellation itself.
  async cancelEvent(id: string) {
    const event = await this.prisma.events.findUnique({
      where: { id },
      select: { id: true, name: true, status: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.status === EventStatus.CANCELLED) {
      return { success: true, already_cancelled: true };
    }

    const affectedReservations = await this.prisma.reservations.findMany({
      where: { event_id: id, status: { not: 'cancelled' } },
      select: {
        id: true,
        user: { select: { push_token: true } },
      },
    });

    await this.prisma.$transaction([
      this.prisma.events.update({
        where: { id },
        data: { status: EventStatus.CANCELLED },
      }),
      this.prisma.reservations.updateMany({
        where: { event_id: id, status: { not: 'cancelled' } },
        data: { status: 'cancelled' },
      }),
    ]);

    await Promise.all(
      affectedReservations
        .filter((r) => r.user?.push_token)
        .map((r) =>
          this.expoPush.send({
            token: r.user!.push_token!,
            title: 'Evento annullato',
            body: `"${event.name}" è stato annullato dal locale. La tua prenotazione è stata cancellata.`,
            data: { type: 'event_cancelled', event_id: id },
          }),
        ),
    );

    return { success: true, cancelled_reservations: affectedReservations.length };
  }

  async deleteEvent(id: string) {
    await this.getEvent(id);

    const [ticketOrdersCount, reservationsCount] = await Promise.all([
      this.prisma.ticket_orders.count({ where: { event_id: id } }),
      this.prisma.reservations.count({ where: { event_id: id } }),
    ]);
    if (ticketOrdersCount > 0 || reservationsCount > 0) {
      throw new BadRequestException(
        'Impossibile eliminare un evento con prenotazioni o ordini collegati. Usa "Annulla evento" per cancellarlo mantenendo lo storico.',
      );
    }

    await this.prisma.$transaction([
      // Delete dependents first to satisfy FK constraints
      this.prisma.reservations.deleteMany({ where: { event_id: id } }),
      this.prisma.event_entry_prices.deleteMany({ where: { event_id: id } }),

      // Promos linked to this event may have user_promos rows
      this.prisma.user_promos.deleteMany({
        where: { promo: { event_id: id } },
      }),
      this.prisma.promos.deleteMany({ where: { event_id: id } }),

      this.prisma.bar_sales.deleteMany({ where: { event_id: id } }),
      this.prisma.cloakroom_sales.deleteMany({ where: { event_id: id } }),
      this.prisma.table_sales.deleteMany({
        where: { event_table: { event_id: id } },
      }),
      this.prisma.entries.deleteMany({ where: { event_id: id } }),
      this.prisma.event_tables.deleteMany({ where: { event_id: id } }),
      this.prisma.events.delete({ where: { id } }),
    ]);
    return { success: true };
  }

  async recalculateEventStats(eventId: string): Promise<EventStats> {
    // Was `await this.getEvent(eventId)` - the full serialized event (venue include +
    // promos + entry_prices, plus 2 extra transactions for table pricing / floor plan
    // resolution, ~1s+ measured) fetched and immediately discarded just to check
    // existence. A bare id-only lookup does the same existence check for a fraction of
    // the cost. Plain `Promise.all` (not `$transaction`) so the 5 independent reads run
    // concurrently on separate pooled connections instead of sequentially on one - see the
    // comment on `loadEventPricingAndFloorPlanSource` for why a batch `$transaction` doesn't
    // actually parallelize anything on a remote pooled DB.
    const [exists, entriesAgg, barAgg, cloakAgg, tableAgg] = await Promise.all([
      this.prisma.events.findUnique({
        where: { id: eventId },
        select: { id: true },
      }),
      this.prisma.entries.aggregate({
        where: { event_id: eventId },
        _count: { id: true },
        _sum: { price: true },
      }),
      this.prisma.bar_sales.aggregate({
        where: { event_id: eventId },
        _sum: { amount: true },
      }),
      this.prisma.cloakroom_sales.aggregate({
        where: { event_id: eventId },
        _sum: { amount: true },
      }),
      this.prisma.event_tables.aggregate({
        where: { event_id: eventId },
        _sum: { pagato_totale: true },
      }),
    ]);

    if (!exists) throw new NotFoundException('Event not found');

    return {
      event_id: eventId,
      total_entries: Number(entriesAgg._count.id ?? 0),
      total_entries_revenue: this.decimalToNumber(entriesAgg._sum.price),
      total_bar: this.decimalToNumber(barAgg._sum.amount),
      total_cloakroom: this.decimalToNumber(cloakAgg._sum.amount),
      total_tables: this.decimalToNumber(tableAgg._sum.pagato_totale),
      last_updated: new Date(),
    };
  }

  async syncEventStatusesNow(params?: {
    daysBack?: number;
    daysForward?: number;
  }) {
    const daysBack = Math.max(0, Math.min(params?.daysBack ?? 2, 7));
    const daysForward = Math.max(0, Math.min(params?.daysForward ?? 2, 7));

    // Only a small moving window can change status over time.
    // Cross-midnight events still belong to their start "date", so yesterday/today/tomorrow is enough.
    const updated = await this.prisma.$executeRaw`
      UPDATE "events" e
      SET "status" = public.compute_event_status(e."date", e."start_time", e."end_time", e."status")
      WHERE e."start_time" IS NOT NULL
        AND e."end_time" IS NOT NULL
        AND e."date" >= (CURRENT_DATE - (${daysBack}::int * interval '1 day'))::date
        AND e."date" <= (CURRENT_DATE + (${daysForward}::int * interval '1 day'))::date
        AND e."status" <> public.compute_event_status(e."date", e."start_time", e."end_time", e."status");
    `;

    return { success: true, updated: Number(updated) };
  }

  // Tunable knobs for the free/automatic side of `is_featured` - see the doc comment above
  // evaluateAutoFeaturedEvents() for what they mean. Kept as named constants (not spread
  // across the query) so the formula is easy to find and retune without reading SQL.
  private static readonly AUTO_FEATURED_RECENT_WINDOW_HOURS = 24;
  private static readonly AUTO_FEATURED_BASELINE_WINDOW_DAYS = 90;
  private static readonly AUTO_FEATURED_MULTIPLIER = 2;
  private static readonly AUTO_FEATURED_MIN_FLOOR = 3;
  private static readonly AUTO_FEATURED_BOOKING_STATUSES: Prisma.Sql = Prisma.sql`('pending', 'confirmed', 'completed')`;

  /**
   * Recomputes the *automatic* side of `events.is_featured` for every upcoming (not CLOSED)
   * event - a free reward for booking velocity, as opposed to an admin manually granting it
   * as a paid placement (see EventsController.create/update). Both write to the same
   * `is_featured` boolean; `featured_source` ('manual' | 'auto') is what keeps them from
   * stepping on each other:
   *   - This job only ever flips events whose `featured_source` is already 'auto' or null -
   *     it never touches (turns on or off) an event an admin explicitly set, because that
   *     would silently take away something a venue paid for, or silently grant a paid-tier
   *     benefit for free.
   *   - When it grants is_featured, it also stamps featured_source = 'auto', so a later run
   *     knows this specific true is one it's allowed to revoke if the hype fades.
   *
   * Formula, relative to each venue's own history (a fixed absolute threshold would be
   * unfair to a small venue that fills up its 40-person room quickly vs. a 500-person venue
   * where the same booking count is nothing):
   *   - `recentCount`   = this event's (pending|confirmed|completed) reservations created in
   *                       the last {AUTO_FEATURED_RECENT_WINDOW_HOURS}h.
   *   - `venueDailyAvg` = that venue's total such reservations over the last
   *                       {AUTO_FEATURED_BASELINE_WINDOW_DAYS} days, divided by that many days.
   *   - qualifies = recentCount >= max(venueDailyAvg * {AUTO_FEATURED_MULTIPLIER}, {AUTO_FEATURED_MIN_FLOOR})
   * The `MIN_FLOOR` matters most for a venue with little/no booking history yet, where
   * `venueDailyAvg` is ~0 and any multiplier of it would trivially qualify every event.
   *
   * Triggered by the same cron as syncEventStatusesNow (see EventsController#syncStatus) -
   * not on every booking, to keep the booking request path free of this computation.
   */
  async evaluateAutoFeaturedEvents(): Promise<{
    success: boolean;
    updated: number;
  }> {
    const { ids: upcomingIds } = await this.listEventIdsByComputedStatus({
      excludeStatus: EventStatus.CLOSED,
    });
    if (!upcomingIds.length) return { success: true, updated: 0 };

    // Only events this job is allowed to touch - anything featured_source = 'manual' is
    // off-limits in both directions.
    const eligibleEvents = await this.prisma.events.findMany({
      where: {
        id: { in: upcomingIds },
        featured_source: { not: 'manual' },
      },
      select: { id: true, venue_id: true, is_featured: true },
    });
    if (!eligibleEvents.length) return { success: true, updated: 0 };

    const venueIds = Array.from(
      new Set(eligibleEvents.map((e) => e.venue_id)),
    );
    const eligibleEventIds = eligibleEvents.map((e) => e.id);

    const [dailyAverageRows, recentCountRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ venue_id: string; daily_avg: number }>>(
        Prisma.sql`
          SELECT e."venue_id" AS venue_id,
                 COUNT(r."id")::float / ${EventsService.AUTO_FEATURED_BASELINE_WINDOW_DAYS} AS daily_avg
          FROM "events" e
          JOIN "reservations" r ON r."event_id" = e."id"
          WHERE e."venue_id" = ANY(${venueIds}::uuid[])
            AND r."status" IN ${EventsService.AUTO_FEATURED_BOOKING_STATUSES}
            AND r."created_at" >= NOW() - (${EventsService.AUTO_FEATURED_BASELINE_WINDOW_DAYS}::int * interval '1 day')
          GROUP BY e."venue_id"
        `,
      ),
      this.prisma.$queryRaw<Array<{ event_id: string; recent_count: number }>>(
        Prisma.sql`
          SELECT r."event_id" AS event_id, COUNT(*)::int AS recent_count
          FROM "reservations" r
          WHERE r."event_id" = ANY(${eligibleEventIds}::uuid[])
            AND r."status" IN ${EventsService.AUTO_FEATURED_BOOKING_STATUSES}
            AND r."created_at" >= NOW() - (${EventsService.AUTO_FEATURED_RECENT_WINDOW_HOURS}::int * interval '1 hour')
          GROUP BY r."event_id"
        `,
      ),
    ]);

    const dailyAverageByVenue = new Map(
      dailyAverageRows.map((r) => [r.venue_id, r.daily_avg]),
    );
    const recentCountByEvent = new Map(
      recentCountRows.map((r) => [r.event_id, r.recent_count]),
    );

    const toFeature: string[] = [];
    const toUnfeature: string[] = [];

    for (const event of eligibleEvents) {
      const dailyAvg = dailyAverageByVenue.get(event.venue_id) ?? 0;
      const recentCount = recentCountByEvent.get(event.id) ?? 0;
      const threshold = Math.max(
        dailyAvg * EventsService.AUTO_FEATURED_MULTIPLIER,
        EventsService.AUTO_FEATURED_MIN_FLOOR,
      );
      const qualifies = recentCount >= threshold;

      if (qualifies !== event.is_featured) {
        (qualifies ? toFeature : toUnfeature).push(event.id);
      }
    }

    const [featuredResult, unfeaturedResult] = await Promise.all([
      toFeature.length
        ? this.prisma.events.updateMany({
            where: { id: { in: toFeature } },
            data: { is_featured: true, featured_source: 'auto' },
          })
        : { count: 0 },
      toUnfeature.length
        ? this.prisma.events.updateMany({
            where: { id: { in: toUnfeature } },
            data: { is_featured: false, featured_source: null },
          })
        : { count: 0 },
    ]);

    return {
      success: true,
      updated: featuredResult.count + unfeaturedResult.count,
    };
  }

  async venueStats(venueId: string) {
    const venueExists = await this.prisma.venues.findUnique({
      where: { id: venueId },
    });
    if (!venueExists) throw new NotFoundException('Venue not found');

    const venueEvents = await this.runPrismaQueryWithRetry(
      'events.venueStats.findMany',
      () =>
        this.prisma.events.findMany({
          where: { venue_id: venueId },
          select: { id: true },
        }),
    );

    const stats = await Promise.all(
      venueEvents.map((e) => this.getEventStats(e.id)),
    );

    const totals = stats.reduce(
      (acc, cur) => {
        acc.total_entries += cur.total_entries;
        acc.total_entries_revenue += cur.total_entries_revenue;
        acc.total_bar += cur.total_bar;
        acc.total_cloakroom += cur.total_cloakroom;
        acc.total_tables += cur.total_tables;
        return acc;
      },
      {
        total_entries: 0,
        total_entries_revenue: 0,
        total_bar: 0,
        total_cloakroom: 0,
        total_tables: 0,
      },
    );

    return { venue_id: venueId, ...totals, events: stats };
  }
}
