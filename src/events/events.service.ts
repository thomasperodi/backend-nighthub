import {
  BadRequestException,
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

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

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

  private nowUtcTimestampExpr() {
    // timestamp without time zone in UTC (matches our @db.Time UTC-component convention)
    return Prisma.sql`(now() AT TIME ZONE 'UTC')`;
  }

  private computedStatusExpr() {
    // Computes DRAFT/LIVE/CLOSED from date + time window.
    // NOTE: returns text to compare against EventStatus enum values.
    const nowUtc = this.nowUtcTimestampExpr();
    return Prisma.sql`
      CASE
        WHEN e."date" IS NULL OR e."start_time" IS NULL OR e."end_time" IS NULL THEN e."status"::text
        ELSE
          CASE
            WHEN ${nowUtc} < (e."date" + e."start_time") THEN 'DRAFT'
            WHEN ${nowUtc} < (
              e."date" + e."end_time" +
              CASE WHEN e."end_time" <= e."start_time" THEN interval '1 day' ELSE interval '0 day' END
            ) THEN 'LIVE'
            ELSE 'CLOSED'
          END
      END
    `;
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

    // Interpret date + HH:MM as local time (venue-friendly).
    // Extract HH:MM from @db.Time using UTC components to avoid timezone drift.
    const [yy, mm, dd] = this.formatDateOnly(e.date)
      .split('-')
      .map((x) => parseInt(x, 10));
    const y = Number.isFinite(yy) ? yy : e.date.getFullYear();
    const m = Number.isFinite(mm) ? mm - 1 : e.date.getMonth();
    const d = Number.isFinite(dd) ? dd : e.date.getDate();

    const sh = e.start_time.getUTCHours();
    const sm = e.start_time.getUTCMinutes();

    const eh = e.end_time.getUTCHours();
    const em = e.end_time.getUTCMinutes();

    const start = new Date(y, m, d, sh, sm, 0, 0);
    const end = new Date(y, m, d, eh, em, 0, 0);

    // Events can end after midnight (e.g. 21:00 -> 03:00)
    if (end.getTime() <= start.getTime()) {
      end.setDate(end.getDate() + 1);
    }

    const now = new Date();
    if (now.getTime() < start.getTime()) return EventStatus.DRAFT;
    if (now.getTime() >= start.getTime() && now.getTime() < end.getTime()) {
      return EventStatus.LIVE;
    }
    return EventStatus.CLOSED;
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
    // YYYY-MM-DD
    return date.toISOString().slice(0, 10);
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.serializeEvent(event);
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
