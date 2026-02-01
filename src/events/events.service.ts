import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DiscountType,
  EventStatus,
  Gender,
  Prisma,
  PromoStatus,
  events,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseStorageService } from '../common/storage/supabase-storage.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

export type EventStats = {
  event_id: string;
  total_entries: number;
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

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

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

  async uploadEventPoster(file?: Express.Multer.File) {
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
    status: EventStatus;
    skip?: number;
    take?: number;
    withTotal?: boolean;
  }): Promise<{ ids: string[]; total?: number }> {
    const venueId = params.venueId ?? null;
    const date = params.date ?? null;
    const skip = params.skip ?? 0;
    const take = params.take;
    const status = params.status;
    const computed = this.computedStatusExpr();

    const whereBase = Prisma.sql`
      FROM "events" e
      WHERE (${venueId}::uuid IS NULL OR e."venue_id" = ${venueId}::uuid)
        AND (${date}::date IS NULL OR e."date" = ${date}::date)
        AND (${computed}) = ${status}
    `;

    let total: number | undefined;
    if (params.withTotal) {
      const rows = await this.prisma.$queryRaw<Array<{ total: number }>>(
        Prisma.sql`SELECT COUNT(*)::int AS total ${whereBase}`,
      );
      total = rows?.[0]?.total ?? 0;
    }

    const limitOffset =
      typeof take === 'number'
        ? Prisma.sql` LIMIT ${take} OFFSET ${skip}`
        : Prisma.empty;

    const idRows = await this.prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`
        SELECT e."id"
        ${whereBase}
        ORDER BY e."date" ASC, e."start_time" ASC NULLS LAST
        ${limitOffset}
      `,
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
    };
  }
  /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument */

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

  private parsePrice(value: number | string): Prisma.Decimal {
    const asNumber = typeof value === 'string' ? Number(value) : value;
    if (!Number.isFinite(asNumber)) {
      throw new BadRequestException('Invalid price value');
    }
    return new Prisma.Decimal(asNumber);
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

    // If the client asks for computed status (LIVE/CLOSED), filter in DB to avoid fetching all rows.
    if (requestedStatus && requestedStatus !== EventStatus.DRAFT) {
      const dateOnly = filters?.date ? filters.date : undefined;
      const { ids } = await this.listEventIdsByComputedStatus({
        venueId: filters?.venue_id,
        date: dateOnly,
        status: requestedStatus,
      });

      if (!ids.length) return [] as events[];

      const rows = await this.prisma.events.findMany({
        where: { id: { in: ids } },
        orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
        select: {
          id: true,
          venue_id: true,
          name: true,
          description: true,
          image: true,
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
      });

      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      await Promise.all(
        ordered.map((e) =>
          this.syncEventStatusIfNeeded(e as EventStatusSyncCandidate),
        ),
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return ordered.map((e) => this.serializeEvent(e)) as any;
    }

    const list = await this.prisma.events.findMany({
      where,
      orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
      select: {
        id: true,
        venue_id: true,
        name: true,
        description: true,
        image: true,
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
    });

    if (this.isDebugEventsEnabled()) {
      console.log('[events.service] listEvents db results', {
        where,
        requestedStatus,
        dbCount: list.length,
        serverNow: new Date().toISOString(),
        tzOffsetMinutes: new Date().getTimezoneOffset(),
      });
    }

    await Promise.all(
      list.map((e) =>
        this.syncEventStatusIfNeeded(e as EventStatusSyncCandidate),
      ),
    );

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

    // For computed statuses (LIVE/CLOSED) we must filter after serialization.
    if (requestedStatus && requestedStatus !== EventStatus.DRAFT) {
      const dateOnly = filters?.date ? filters.date : undefined;
      const { ids, total } = await this.listEventIdsByComputedStatus({
        venueId: filters?.venue_id,
        date: dateOnly,
        status: requestedStatus,
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

      const rows = await this.prisma.events.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          venue_id: true,
          name: true,
          description: true,
          image: true,
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
      });

      const byId = new Map(rows.map((r) => [r.id, r]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      await Promise.all(
        ordered.map((e) =>
          this.syncEventStatusIfNeeded(e as EventStatusSyncCandidate),
        ),
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

    const [total, data] = await this.prisma.$transaction([
      this.prisma.events.count({ where }),
      this.prisma.events.findMany({
        where,
        orderBy: [{ date: 'asc' }, { start_time: 'asc' }],
        skip,
        take,
        select: {
          id: true,
          venue_id: true,
          name: true,
          description: true,
          image: true,
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
    ]);

    await Promise.all(
      data.map((e) =>
        this.syncEventStatusIfNeeded(e as EventStatusSyncCandidate),
      ),
    );

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
    const event = await this.prisma.events.findUnique({
      where: { id },
      include: {
        promos: true,
        entry_prices: { orderBy: { created_at: 'asc' } },
      },
    });
    if (!event) throw new NotFoundException('Event not found');
    await this.syncEventStatusIfNeeded(event as EventStatusSyncCandidate);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.serializeEvent(event);
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
        date,
        start_time,
        end_time,
        status,
        entry_prices: entryPricesCreate.length
          ? { create: entryPricesCreate }
          : undefined,
        promos: promosCreate.length ? { create: promosCreate } : undefined,
      },
      include: {
        promos: true,
        entry_prices: { orderBy: { created_at: 'asc' } },
      },
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.serializeEvent(event);
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
          date,
          start_time,
          end_time,
          status,
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
    });

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.getEvent(id);
  }

  async deleteEvent(id: string) {
    await this.getEvent(id);
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
    await this.getEvent(eventId);

    const [entriesCount, barAgg, cloakAgg, tableAgg] =
      await this.prisma.$transaction([
        this.prisma.entries.count({ where: { event_id: eventId } }),
        this.prisma.bar_sales.aggregate({
          where: { event_id: eventId },
          _sum: { amount: true },
        }),
        this.prisma.cloakroom_sales.aggregate({
          where: { event_id: eventId },
          _sum: { amount: true },
        }),
        this.prisma.table_sales.aggregate({
          where: { event_table: { event_id: eventId } },
          _sum: { amount: true },
        }),
      ]);

    return {
      event_id: eventId,
      total_entries: entriesCount,
      total_bar: this.decimalToNumber(barAgg._sum.amount),
      total_cloakroom: this.decimalToNumber(cloakAgg._sum.amount),
      total_tables: this.decimalToNumber(tableAgg._sum.amount),
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

  async venueStats(venueId: string) {
    const venueExists = await this.prisma.venues.findUnique({
      where: { id: venueId },
    });
    if (!venueExists) throw new NotFoundException('Venue not found');

    const venueEvents = await this.prisma.events.findMany({
      where: { venue_id: venueId },
      select: { id: true },
    });

    const stats = await Promise.all(
      venueEvents.map((e) => this.getEventStats(e.id)),
    );

    const totals = stats.reduce(
      (acc, cur) => {
        acc.total_entries += cur.total_entries;
        acc.total_bar += cur.total_bar;
        acc.total_cloakroom += cur.total_cloakroom;
        acc.total_tables += cur.total_tables;
        return acc;
      },
      { total_entries: 0, total_bar: 0, total_cloakroom: 0, total_tables: 0 },
    );

    return { venue_id: venueId, ...totals, events: stats };
  }
}
