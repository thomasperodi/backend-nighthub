import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AgeBucket,
  EntryMethod,
  Gender,
  Prisma,
  TableBottleOrderStatus,
  VenueStationType,
  bar_sales,
  cloakroom_sales,
  table_sales,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RecordEntryDto } from './dto/record-entry.dto';
import { RecordSaleDto } from './dto/record-sale.dto';
import { UpdateTableHostessDto } from './dto/update-table-hostess.dto';
import { EventsService } from '../events/events.service';
import { resolveEntryUnitPrice } from '../common/entry-pricing';
import { CreateTableBottleOrderDto } from './dto/create-table-bottle-order.dto';

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsService: EventsService,
  ) {}

  async assertEventBelongsToVenue(eventId: string, venueId: string) {
    const e = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { id: true, venue_id: true },
    });
    if (!e) throw new NotFoundException('Event not found');
    if (e.venue_id !== venueId) throw new ForbiddenException('Forbidden');
  }

  async assertEventTableBelongsToVenue(eventTableId: string, venueId: string) {
    const t = await this.prisma.event_tables.findUnique({
      where: { id: eventTableId },
      select: { id: true, event: { select: { venue_id: true } } },
    });
    if (!t) throw new NotFoundException('Table not found');
    if (t.event.venue_id !== venueId) {
      throw new ForbiddenException('Forbidden');
    }
  }

  async assertBottleOrderBelongsToVenue(orderId: string, venueId: string) {
    const order = await this.prisma.table_bottle_orders.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        event_table: { select: { event: { select: { venue_id: true } } } },
      },
    });
    if (!order) throw new NotFoundException('Bottle order not found');
    if (order.event_table.event.venue_id !== venueId) {
      throw new ForbiddenException('Forbidden');
    }
  }

  private isDebugStaffEnabled(): boolean {
    return process.env.DEBUG_STAFF === '1';
  }

  private async resolveVenueIdFromStaffId(staffId: string): Promise<string> {
    const u = await this.prisma.users.findUnique({
      where: { id: staffId },
      select: { venue_id: true },
    });
    const venueId = u?.venue_id ?? null;
    if (!venueId) throw new BadRequestException('staff user has no venue_id');
    return venueId;
  }

  private async resolveVenueIdFromEventId(eventId: string): Promise<string> {
    const event = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { venue_id: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    return event.venue_id;
  }

  private async resolveEventContextFromEventTableId(eventTableId: string) {
    const eventTable = await this.prisma.event_tables.findUnique({
      where: { id: eventTableId },
      select: {
        event_id: true,
        event: { select: { venue_id: true } },
      },
    });
    if (!eventTable) throw new NotFoundException('Table not found');
    return {
      eventId: eventTable.event_id,
      venueId: eventTable.event.venue_id,
    };
  }

  private async resolveStationId(params: {
    stationId?: string | null;
    eventId?: string | null;
    venueId?: string | null;
    eventTableId?: string | null;
    stationType: VenueStationType;
  }): Promise<string | null> {
    let resolvedVenueId = params.venueId ?? null;

    if (!resolvedVenueId && params.eventId) {
      resolvedVenueId = await this.resolveVenueIdFromEventId(params.eventId);
    }

    if (!resolvedVenueId && params.eventTableId) {
      const eventContext = await this.resolveEventContextFromEventTableId(
        params.eventTableId,
      );
      resolvedVenueId = eventContext.venueId;
    }

    if (params.stationId) {
      const station = await this.prisma.venue_stations.findUnique({
        where: { id: params.stationId },
        select: {
          id: true,
          venue_id: true,
          station_type: true,
          is_active: true,
        },
      });

      if (!station) throw new NotFoundException('Station not found');
      if (resolvedVenueId && station.venue_id !== resolvedVenueId) {
        throw new BadRequestException('station_id does not belong to the event venue');
      }
      if (station.station_type !== params.stationType) {
        throw new BadRequestException('station_id does not match the sale type');
      }
      if (!station.is_active) {
        throw new BadRequestException('station_id is not active');
      }
      return station.id;
    }

    if (!resolvedVenueId) return null;

    const fallbackStation = await this.prisma.venue_stations.findFirst({
      where: {
        venue_id: resolvedVenueId,
        station_type: params.stationType,
        is_active: true,
      },
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      select: { id: true },
    });

    return fallbackStation?.id ?? null;
  }

  private async resolveActiveLiveEventIdForVenue(
    venueId: string,
  ): Promise<string> {
    const live = await this.eventsService.listEvents({
      venue_id: venueId,
      status: 'LIVE',
    });

    const first = live[0];
    if (!first) throw new NotFoundException('No LIVE event found for venue');
    return first.id;
  }

  private async resolveEventId(params: {
    eventId?: string;
    venueId?: string;
    staffId?: string;
    eventTableId?: string;
  }): Promise<string> {
    const { eventId, venueId, staffId, eventTableId } = params;

    if (eventId) {
      await this.ensureEvent(eventId);
      return eventId;
    }

    if (eventTableId) {
      const row = await this.prisma.event_tables.findUnique({
        where: { id: eventTableId },
        select: { event_id: true },
      });
      if (row?.event_id) return row.event_id;
    }

    const resolvedVenueId = venueId
      ? venueId
      : staffId
        ? await this.resolveVenueIdFromStaffId(staffId)
        : null;

    if (!resolvedVenueId) {
      throw new BadRequestException(
        'eventId or venueId or staffId is required',
      );
    }

    const resolvedEventId =
      await this.resolveActiveLiveEventIdForVenue(resolvedVenueId);

    if (this.isDebugStaffEnabled()) {
      console.log('[staff.service] resolveEventId', {
        eventId: eventId ?? null,
        venueId: resolvedVenueId,
        staffId: staffId ?? null,
        eventTableId: eventTableId ?? null,
        resolvedEventId,
        now: new Date().toISOString(),
      });
    }

    return resolvedEventId;
  }

  // Public wrapper for controllers (keeps core resolver centralized)
  async resolveEventIdForStaffApi(params: {
    eventId?: string;
    venueId?: string;
    staffId?: string;
    eventTableId?: string;
  }): Promise<string> {
    return this.resolveEventId(params);
  }

  private async ensureEvent(event_id: string) {
    const exists = await this.prisma.events.findUnique({
      where: { id: event_id },
    });
    if (!exists) throw new NotFoundException('Event not found');
  }

  private async ensureEventTablesSeeded(eventId: string) {
    if (!eventId) return;

    const event = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { id: true, venue_id: true },
    });
    if (!event) throw new NotFoundException('Event not found');

    const venueTables = await this.prisma.venue_tables.findMany({
      where: { venue_id: event.venue_id },
      select: { id: true },
    });
    const existingEventTables = await this.prisma.event_tables.findMany({
      where: { event_id: eventId },
      select: { id: true, venue_table_id: true, prenotati: true },
    });

    const venueTableCount = venueTables.length;
    if (!venueTableCount) return;

    // Aggregate prenotati from reservations
    const grouped = await this.prisma.reservations.groupBy({
      by: ['venue_table_id'],
      where: {
        event_id: eventId,
        type: 'table',
        status: { in: ['pending', 'confirmed', 'completed'] },
        venue_table_id: { not: null },
      },
      _sum: { guests: true },
    });

    const prenotatiByVenueTableId = new Map<string, number>();
    for (const g of grouped) {
      const venueTableId = g.venue_table_id;
      if (!venueTableId) continue;
      prenotatiByVenueTableId.set(venueTableId, Number(g._sum.guests ?? 0));
    }

    const selectedVenueTableIds =
      existingEventTables.length > 0
        ? existingEventTables.map((row) => row.venue_table_id)
        : venueTables.map((vt) => vt.id);

    if (existingEventTables.length === 0) {
      await this.prisma.event_tables.createMany({
        data: selectedVenueTableIds.map((venueTableId) => ({
          event_id: eventId,
          venue_table_id: venueTableId,
          prenotati: prenotatiByVenueTableId.get(venueTableId) ?? 0,
          entrati: 0,
          pagato_totale: 0,
          stato: 'libero',
        })),
        skipDuplicates: true,
      });
    }

    // Sync prenotati for existing rows (idempotent)
    const current = await this.prisma.event_tables.findMany({
      where: { event_id: eventId },
      select: { id: true, venue_table_id: true, prenotati: true },
    });

    const updates: Array<Prisma.PrismaPromise<unknown>> = [];
    for (const row of current) {
      const desired = prenotatiByVenueTableId.get(row.venue_table_id) ?? 0;
      if ((row.prenotati ?? 0) !== desired) {
        updates.push(
          this.prisma.event_tables.update({
            where: { id: row.id },
            data: { prenotati: desired },
          }),
        );
      }
    }
    if (updates.length) {
      await this.prisma.$transaction(updates);
    }
  }

  private entryTypeToGender(entryType: RecordEntryDto['entry_type']): Gender {
    if (entryType === 'male') return Gender.M;
    if (entryType === 'female') return Gender.F;
    return Gender.ALTRO;
  }

  private normalizeGenderInput(gender?: RecordEntryDto['gender']): Gender | null {
    if (gender === 'M') return Gender.M;
    if (gender === 'F') return Gender.F;
    if (gender === 'ALTRO') return Gender.ALTRO;
    return null;
  }

  private normalizeAgeBucketInput(
    bucket?: RecordEntryDto['age_bucket'],
  ): AgeBucket | null {
    if (!bucket) return null;
    if (bucket === 'AGE_18_20') return AgeBucket.AGE_18_20;
    if (bucket === 'AGE_21_24') return AgeBucket.AGE_21_24;
    if (bucket === 'AGE_25_29') return AgeBucket.AGE_25_29;
    if (bucket === 'AGE_30_34') return AgeBucket.AGE_30_34;
    if (bucket === 'AGE_35_PLUS') return AgeBucket.AGE_35_PLUS;
    return AgeBucket.UNKNOWN;
  }

  private async sendExpoPush(params: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }) {
    const token = params.token || '';
    const isExpoToken =
      token.startsWith('ExponentPushToken') ||
      token.startsWith('ExpoPushToken');
    if (!isExpoToken) return;

    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: token,
          title: params.title,
          body: params.body,
          sound: 'default',
          priority: 'high',
          content_available: true,
          data: params.data ?? {},
        }),
      });
    } catch {
      // Best-effort only.
    }
  }

  async recordEntry(dto: RecordEntryDto) {
    const quantity = dto.quantity ?? 1;
    if (quantity <= 0)
      throw new BadRequestException('quantity must be positive');

    if (dto.user_id && quantity !== 1) {
      throw new BadRequestException(
        'quantity must be 1 when user_id is provided',
      );
    }

    const payload = dto as unknown as Record<string, unknown>;
    const eventIdInput =
      typeof payload['event_id'] === 'string' ? payload['event_id'] : undefined;
    const staffIdInput =
      typeof payload['staff_id'] === 'string' ? payload['staff_id'] : undefined;

    const eventId = await this.resolveEventId({
      eventId: eventIdInput,
      staffId: staffIdInput,
    });
    await this.ensureEvent(eventId);
    const stationId = await this.resolveStationId({
      stationId: dto.station_id ?? null,
      eventId,
      stationType: VenueStationType.entry,
    });

    const explicitGender = this.normalizeGenderInput(dto.gender);
    const fallbackGender = dto.entry_type
      ? this.entryTypeToGender(dto.entry_type)
      : null;
    const sesso = explicitGender ?? fallbackGender ?? Gender.ALTRO;

    const isComplimentary =
      dto.is_complimentary ?? (dto.entry_type ? dto.entry_type === 'free' : false);
    const ageBucket = this.normalizeAgeBucketInput(dto.age_bucket);
    const method = dto.user_id ? EntryMethod.QR : EntryMethod.RAPIDO;
    const entryPrice = await resolveEntryUnitPrice({
      prisma: this.prisma,
      eventId,
      gender: sesso,
      isComplimentary,
    });

    if (this.isDebugStaffEnabled()) {
      console.log('[staff.service] recordEntry.input', {
        eventId,
        staffId: dto.staff_id ?? null,
        stationId,
        quantity,
        userId: dto.user_id ?? null,
        entryType: dto.entry_type ?? null,
        genderInput: dto.gender ?? null,
        resolvedGender: sesso,
        isComplimentary,
        ageBucket,
        method,
        unitPrice: entryPrice?.toString?.() ?? String(entryPrice),
      });
    }

    const createData: Prisma.entriesCreateManyInput[] = Array.from(
      { length: quantity },
      () => ({
        event_id: eventId,
        staff_id: dto.staff_id ?? null,
        station_id: stationId,
        user_id: dto.user_id ?? null,
        sesso,
        price: entryPrice,
        is_complimentary: isComplimentary,
        age_bucket: ageBucket,
        method,
      }),
    );

    await this.prisma.entries.createMany({ data: createData });
    const stats = await this.eventsService.recalculateEventStats(eventId);

    if (this.isDebugStaffEnabled()) {
      console.log('[staff.service] recordEntry.success', {
        eventId,
        created: quantity,
        totalEntries: stats?.total_entries ?? null,
        totalEntriesRevenue: stats?.total_entries_revenue ?? null,
      });
    }

    if (dto.user_id) {
      const user = await this.prisma.users.findUnique({
        where: { id: dto.user_id },
        select: { push_token: true },
      });

      const event = await this.prisma.events.findUnique({
        where: { id: eventId },
        include: { venue: true },
      });

      const venue = event?.venue ?? null;
      const latitude = venue?.latitude ? Number(venue.latitude) : null;
      const longitude = venue?.longitude ? Number(venue.longitude) : null;
      const radius = venue?.radius_geofence ?? 100;

      if (
        user?.push_token &&
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        venue?.id
      ) {
        await this.sendExpoPush({
          token: user.push_token,
          title: 'Ingresso al locale',
          body: `Monitoraggio posizione attivato per ${venue.name ?? 'il locale'}.`,
          data: {
            type: 'venue_stay',
            venue_id: venue.id,
            latitude,
            longitude,
            radius,
          },
        });
      }
    }

    return { success: true, created: quantity, stats };
  }

  async recordBarSale(dto: RecordSaleDto) {
    return this.recordSale('bar', dto);
  }

  async recordCloakroomSale(dto: RecordSaleDto) {
    return this.recordSale('cloakroom', dto);
  }

  async recordTableSale(dto: RecordSaleDto) {
    return this.recordSale('table', dto);
  }

  private async recordSale(
    kind: 'bar' | 'cloakroom' | 'table',
    dto: RecordSaleDto,
  ) {
    if (dto.amount === undefined || dto.amount === null) {
      throw new BadRequestException('amount is required');
    }
    if (dto.amount < 0)
      throw new BadRequestException('amount must be non-negative');

    let sale: bar_sales | cloakroom_sales | table_sales;
    if (kind === 'bar' || kind === 'cloakroom') {
      const payload = dto as unknown as Record<string, unknown>;
      const eventIdInput =
        typeof payload['event_id'] === 'string'
          ? payload['event_id']
          : undefined;
      const staffIdInput =
        typeof payload['staff_id'] === 'string'
          ? payload['staff_id']
          : undefined;

      const eventId = await this.resolveEventId({
        eventId: eventIdInput,
        staffId: staffIdInput,
      });
      await this.ensureEvent(eventId);
      const stationType =
        kind === 'bar' ? VenueStationType.bar : VenueStationType.cloakroom;
      const stationId = await this.resolveStationId({
        stationId: dto.station_id ?? null,
        eventId,
        stationType,
      });

      if (kind === 'bar') {
        sale = await this.prisma.bar_sales.create({
          data: {
            event_id: eventId,
            staff_id: dto.staff_id ?? null,
            station_id: stationId,
            amount: dto.amount,
          },
        });
      } else {
        sale = await this.prisma.cloakroom_sales.create({
          data: {
            event_id: eventId,
            staff_id: dto.staff_id ?? null,
            station_id: stationId,
            amount: dto.amount,
          },
        });
      }
    } else {
      if (!dto.event_table_id) {
        throw new BadRequestException(
          'event_table_id is required for table sales',
        );
      }

      const eventContext = await this.resolveEventContextFromEventTableId(
        dto.event_table_id,
      );
      const stationId = await this.resolveStationId({
        stationId: dto.station_id ?? null,
        eventTableId: dto.event_table_id,
        stationType: VenueStationType.table,
      });

      sale = await this.prisma.table_sales.create({
        data: {
          event_id: eventContext.eventId,
          event_table_id: dto.event_table_id,
          staff_id: dto.staff_id ?? null,
          station_id: stationId,
          amount: dto.amount,
        },
      });

      await this.prisma.event_tables.update({
        where: { id: dto.event_table_id },
        data: { pagato_totale: { increment: dto.amount } },
      });
    }

    const payload = dto as unknown as Record<string, unknown>;
    const resolvedEventId = await this.resolveEventId({
      eventId:
        typeof payload['event_id'] === 'string'
          ? payload['event_id']
          : undefined,
      staffId:
        typeof payload['staff_id'] === 'string'
          ? payload['staff_id']
          : undefined,
      eventTableId:
        typeof payload['event_table_id'] === 'string'
          ? payload['event_table_id']
          : undefined,
    }).catch(() => undefined);

    const stats = resolvedEventId
      ? await this.eventsService.recalculateEventStats(resolvedEventId)
      : null;

    return { sale, stats };
  }

  async listEntries(eventId?: string) {
    return this.prisma.entries.findMany({
      where: eventId ? { event_id: eventId } : undefined,
      orderBy: { created_at: 'desc' },
    });
  }

  async listBarSales(eventId?: string) {
    return this.prisma.bar_sales.findMany({
      where: eventId ? { event_id: eventId } : undefined,
      orderBy: { created_at: 'desc' },
    });
  }

  async listCloakroomSales(eventId?: string) {
    return this.prisma.cloakroom_sales.findMany({
      where: eventId ? { event_id: eventId } : undefined,
      orderBy: { created_at: 'desc' },
    });
  }

  async listTableSales(eventId?: string) {
    return this.prisma.table_sales.findMany({
      where: eventId ? { event_table: { event_id: eventId } } : undefined,
      orderBy: { created_at: 'desc' },
    });
  }

  private mapBottleOrder(order: any) {
    const tableLabel =
      order.event_table?.assigned_number ?? order.event_table?.venue_table?.numero ?? null;

    return {
      id: order.id,
      event_table_id: order.event_table_id,
      bottle_name: order.bottle_name,
      quantity: Number(order.quantity ?? 0),
      unit_price: Number(order.unit_price ?? 0),
      total_price: Number(order.total_price ?? 0),
      status: String(order.status ?? 'requested').toLowerCase(),
      note: order.note ?? null,
      created_at: order.created_at,
      prepared_at: order.prepared_at ?? null,
      delivered_at: order.delivered_at ?? null,
      requested_by_staff_id: order.requested_by_staff_id ?? null,
      prepared_by_staff_id: order.prepared_by_staff_id ?? null,
      delivered_by_staff_id: order.delivered_by_staff_id ?? null,
      is_table_saldato:
        String(order.event_table?.stato ?? '').toLowerCase() === 'saldato',
      table: order.event_table
        ? {
            id: order.event_table.id,
            event_id: order.event_table.event_id,
            numero: tableLabel,
            nome: order.event_table.venue_table?.nome ?? 'Tavolo',
            zona: order.event_table.venue_table?.zona ?? null,
            table_name: order.event_table.table_name ?? null,
            prenotati: Number(order.event_table.prenotati ?? 0),
            entrati: Number(order.event_table.entrati ?? 0),
          }
        : null,
    };
  }

  private async getBottleOrderById(orderId: string, venueId?: string) {
    const order = await this.prisma.table_bottle_orders.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        event_table_id: true,
        requested_by_staff_id: true,
        prepared_by_staff_id: true,
        delivered_by_staff_id: true,
        bottle_name: true,
        quantity: true,
        unit_price: true,
        total_price: true,
        status: true,
        note: true,
        created_at: true,
        prepared_at: true,
        delivered_at: true,
        event_table: {
          select: {
            id: true,
            event_id: true,
            venue_table_id: true,
            assigned_number: true,
            prenotati: true,
            entrati: true,
            stato: true,
            venue_table: {
              select: {
                numero: true,
                nome: true,
                zona: true,
                venue_id: true,
              },
            },
          },
        },
      },
    });

    if (!order) throw new NotFoundException('Bottle order not found');
    if (venueId && order.event_table.venue_table?.venue_id !== venueId) {
      throw new ForbiddenException('Forbidden');
    }

    const tableNameByVenueTableId = await this.resolveReservationTableNames({
      eventId: order.event_table.event_id,
      venueId,
    });

    return this.mapBottleOrder({
      ...order,
      event_table: {
        ...order.event_table,
        table_name:
          tableNameByVenueTableId.get(order.event_table.venue_table_id) ?? null,
      },
    });
  }

  private async resolveReservationTableNames(params: {
    eventId: string;
    venueId?: string;
  }): Promise<Map<string, string>> {
    const { eventId, venueId } = params;

    const venueFilter = venueId
      ? Prisma.sql`AND vt.venue_id = ${venueId}::uuid`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ venue_table_id: string | null; table_name: string | null }>
    >(Prisma.sql`
      SELECT r.venue_table_id, r.table_name
      FROM reservations r
      JOIN venue_tables vt ON vt.id = r.venue_table_id
      WHERE r.event_id = ${eventId}::uuid
        AND r.type = 'table'
        AND r.status IN ('pending', 'confirmed', 'completed')
        AND r.table_name IS NOT NULL
        AND BTRIM(r.table_name) <> ''
        ${venueFilter}
      ORDER BY r.created_at DESC
    `);

    const tableNameByVenueTableId = new Map<string, string>();
    for (const row of rows) {
      const venueTableId = row?.venue_table_id
        ? String(row.venue_table_id)
        : '';
      const tableName = row?.table_name ? String(row.table_name).trim() : '';
      if (!venueTableId || !tableName) continue;
      if (!tableNameByVenueTableId.has(venueTableId)) {
        tableNameByVenueTableId.set(venueTableId, tableName);
      }
    }

    return tableNameByVenueTableId;
  }

  // Hostess tables
  async listHostessTables(params: {
    eventId?: string;
    venueId?: string;
    onlyBooked?: boolean;
    includeConfirmed?: boolean;
  }) {
    const { eventId, venueId, includeConfirmed = true } = params;

    if (!eventId) {
      return [];
    }

    await this.ensureEventTablesSeeded(eventId);

    const groupedReservations = await this.prisma.reservations.groupBy({
      by: ['venue_table_id'],
      where: {
        event_id: eventId,
        type: 'table',
        status: 'confirmed',
        venue_table_id: { not: null },
        ...(venueId ? { venue_table: { venue_id: venueId } } : {}),
      },
      _sum: { guests: true },
    });

    const prenotatiByVenueTableId = new Map<string, number>();
    for (const reservation of groupedReservations) {
      const venueTableId = reservation.venue_table_id;
      if (!venueTableId) continue;
      prenotatiByVenueTableId.set(
        venueTableId,
        Number(reservation._sum.guests ?? 0),
      );
    }

    const bookedVenueTableIds = Array.from(prenotatiByVenueTableId.keys());
    if (!bookedVenueTableIds.length) {
      return [];
    }

    const tables = await this.prisma.event_tables.findMany({
      where: {
        event_id: eventId,
        venue_table_id: { in: bookedVenueTableIds },
        ...(includeConfirmed ? {} : { confermato: false }),
        ...(venueId ? { venue_table: { venue_id: venueId } } : {}),
      },
      include: { venue_table: true, event: true },
      orderBy: [{ venue_table: { numero: 'asc' } }],
    });

    const tableNameByVenueTableId = await this.resolveReservationTableNames({
      eventId,
      venueId,
    });

    return tables.map((t) => {
      const prenotati = prenotatiByVenueTableId.get(t.venue_table_id) ?? 0;
      const per_testa = t.per_testa_override ?? t.venue_table?.per_testa ?? 0;
      const costo_minimo =
        t.costo_minimo_override ?? t.venue_table?.costo_minimo ?? null;
      const stato =
        t.entrati >= prenotati
          ? 'completo'
          : t.entrati > 0
            ? 'parziale'
            : 'attesa';

      return {
        id: t.id,
        event_id: t.event_id,
        venue_table_id: t.venue_table_id,
        table_name: tableNameByVenueTableId.get(t.venue_table_id) ?? null,
        prenotati,
        entrati: t.entrati,
        pagato_totale: t.pagato_totale,
        per_testa,
        costo_minimo,
        confermato: Boolean((t as any).confermato),
        stato,
        numero: t.assigned_number ?? t.venue_table?.numero ?? null,
        venue_table: t.venue_table,
        event: t.event,
      };
    });
  }

  // Cameriere tables
  async listWaiterTables(params: {
    eventId?: string;
    venueId?: string;
    onlyBooked?: boolean;
  }) {
    const { eventId, venueId, onlyBooked } = params;
    if (!eventId) {
      return [];
    }

    await this.ensureEventTablesSeeded(eventId);

    const rows = await this.prisma.event_tables.findMany({
      where: {
        event_id: eventId,
        ...(venueId ? { venue_table: { venue_id: venueId } } : {}),
        ...(onlyBooked ? { prenotati: { gt: 0 } } : {}),
      },
      select: {
        id: true,
        event_id: true,
        venue_table_id: true,
        assigned_number: true,
        per_testa_override: true,
        costo_minimo_override: true,
        venue_table: {
          select: {
            venue_id: true,
            nome: true,
            zona: true,
            per_testa: true,
            costo_minimo: true,
            numero: true,
          },
        },
        prenotati: true,
        entrati: true,
        pagato_totale: true,
        stato: true,
        table_sales: { orderBy: { created_at: 'desc' }, take: 50 },
        bottle_orders: {
          orderBy: [{ created_at: 'desc' }],
          take: 20,
          select: {
            id: true,
            event_table_id: true,
            requested_by_staff_id: true,
            prepared_by_staff_id: true,
            delivered_by_staff_id: true,
            bottle_name: true,
            quantity: true,
            unit_price: true,
            total_price: true,
            status: true,
            note: true,
            created_at: true,
            prepared_at: true,
            delivered_at: true,
          },
        },
      },
      orderBy: [{ venue_table: { numero: 'asc' } }],
    });

    const tableNameByVenueTableId = await this.resolveReservationTableNames({
      eventId,
      venueId,
    });

    return rows.map((t) => {
      const is_saldato = (t.stato ?? '').toLowerCase() === 'saldato';
      const pagato_totale = t.pagato_totale;
      const per_testa = t.per_testa_override ?? t.venue_table?.per_testa ?? 0;
      const costo_minimo =
        t.costo_minimo_override ?? t.venue_table?.costo_minimo ?? null;

      return {
        id: t.id,
        event_id: t.event_id,
        venue_id: t.venue_table?.venue_id ?? null,
        nome: t.venue_table?.nome ?? 'Tavolo',
        table_name: tableNameByVenueTableId.get(t.venue_table_id) ?? null,
        zona: t.venue_table?.zona ?? null,
        per_testa,
        costo_minimo,
        prenotati: t.prenotati ?? 0,
        entrati: t.entrati ?? 0,
        numero: t.assigned_number ?? t.venue_table?.numero ?? null,
        pagato_iniziale: null,
        pagato_totale,
        stato_pagamento: is_saldato
          ? 'saldato'
          : Number(pagato_totale ?? 0) > 0
            ? 'parziale'
            : 'in_attesa',
        is_saldato,
        table_waiters: [],
        table_sales: (t.table_sales ?? []).map((s) => ({
          id: s.id,
          amount: Number(s.amount ?? 0),
          created_at: s.created_at,
        })),
        bottle_orders: (t.bottle_orders ?? []).map((order) => ({
          id: order.id,
          event_table_id: order.event_table_id,
          requested_by_staff_id: order.requested_by_staff_id ?? null,
          prepared_by_staff_id: order.prepared_by_staff_id ?? null,
          delivered_by_staff_id: order.delivered_by_staff_id ?? null,
          bottle_name: order.bottle_name,
          quantity: Number(order.quantity ?? 0),
          unit_price: Number(order.unit_price ?? 0),
          total_price: Number(order.total_price ?? 0),
          status: String(order.status ?? 'requested').toLowerCase(),
          note: order.note ?? null,
          created_at: order.created_at,
          prepared_at: order.prepared_at ?? null,
          delivered_at: order.delivered_at ?? null,
        })),
      };
    });
  }

  async updateHostessTableEntrati(id: string, delta: number) {
    if (!delta) throw new BadRequestException('delta must be non-zero');
    const table = await this.prisma.event_tables.findUnique({ where: { id } });
    if (!table) throw new NotFoundException('Table not found');
    const next = (table.entrati ?? 0) + delta;
    if (next < 0) throw new BadRequestException('entrati cannot be negative');
    const updated = await this.prisma.event_tables.update({
      where: { id },
      data: {
        entrati: next,
        ...(next < Number(table.prenotati ?? 0) ? { confermato: false } : {}),
      },
    });
    return updated;
  }

  async setHostessTableConfirmed(id: string, confirmed: boolean) {
    const table = await this.prisma.event_tables.findUnique({ where: { id } });
    if (!table) throw new NotFoundException('Table not found');

    const updated = await this.prisma.event_tables.update({
      where: { id },
      data: { confermato: confirmed } as any,
    });

    return updated;
  }

  async assignHostessTableNumber(id: string, numero: number) {
    if (!Number.isFinite(numero))
      throw new BadRequestException('numero must be a valid number');
    if (!Number.isInteger(numero) || numero <= 0) {
      throw new BadRequestException('numero must be a positive integer');
    }

    const table = await this.prisma.event_tables.findUnique({
      where: { id },
      include: { venue_table: true },
    });
    if (!table) throw new NotFoundException('Table not found');

    const alreadyAssigned = await this.prisma.event_tables.findFirst({
      where: {
        event_id: table.event_id,
        assigned_number: numero,
        NOT: { id },
      },
      select: { id: true },
    });

    if (alreadyAssigned) {
      throw new BadRequestException(
        'Numero tavolo già assegnato a un altro tavolo prenotato',
      );
    }

    const updatedEventTable = await this.prisma.event_tables.update({
      where: { id },
      data: { assigned_number: numero },
      include: { venue_table: true },
    });

    return updatedEventTable;
  }

  // Hostess: aggiorna persone entrate e pagamento iniziale
  async updateTableHostess(id: string, dto: UpdateTableHostessDto) {
    const table = await this.prisma.event_tables.findUnique({ where: { id } });
    if (!table) throw new NotFoundException('Table not found');

    const updateData: Record<string, any> = {};

    if (dto.entrati !== undefined) {
      if (dto.entrati < 0) {
        throw new BadRequestException('entrati cannot be negative');
      }
      updateData.entrati = dto.entrati;
    }

    if (dto.pagato_iniziale !== undefined) {
      if (dto.pagato_iniziale < 0) {
        throw new BadRequestException('pagato_iniziale cannot be negative');
      }
      updateData.pagato_totale = dto.pagato_iniziale;
    }

    const updated = await this.prisma.event_tables.update({
      where: { id },
      data: updateData,
    });

    return updated;
  }

  // Cameriere: aggiunge pagamento al tavolo
  async addTablePayment(
    tableId: string,
    amount: number,
    options?: { staffId?: string; stationId?: string },
  ) {
    const table = await this.prisma.event_tables.findUnique({
      where: { id: tableId },
      select: {
        id: true,
        event_id: true,
        event: { select: { venue_id: true } },
      },
    });
    if (!table) throw new NotFoundException('Table not found');

    if (amount <= 0) {
      throw new BadRequestException('amount must be positive');
    }

    const stationId = await this.resolveStationId({
      stationId: options?.stationId ?? null,
      venueId: table.event.venue_id,
      stationType: VenueStationType.table,
    });

    // Crea record in table_sales
    const sale = await this.prisma.table_sales.create({
      data: {
        event_id: table.event_id,
        event_table_id: tableId,
        staff_id: options?.staffId ?? null,
        station_id: stationId,
        amount,
      },
    });

    const updated = await this.prisma.event_tables.update({
      where: { id: tableId },
      data: {
        pagato_totale: { increment: amount },
      },
    });

    // Ricalcola stats dell'evento
    await this.eventsService.recalculateEventStats(table.event_id);

    return { table: updated, sale };
  }

  async createTableBottleOrder(
    tableId: string,
    dto: CreateTableBottleOrderDto,
    options?: { staffId?: string; autoSettle?: boolean; stationId?: string },
  ) {
    const bottleKey = String(dto.bottle_key ?? '').trim();
    let bottleName = String(dto.bottle_name ?? '').trim();
    const quantity = Number(dto.quantity ?? 0);
    let unitPrice = Number(dto.unit_price ?? 0);

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('quantity must be a positive integer');
    }

    const table = await this.prisma.event_tables.findUnique({
      where: { id: tableId },
      select: {
        id: true,
        event_id: true,
        event: { select: { venue_id: true } },
      },
    });
    if (!table) throw new NotFoundException('Table not found');

    if (bottleKey) {
      const venue = await this.prisma.venues.findUnique({
        where: { id: table.event.venue_id },
        select: { bottle_price_list: true },
      });

      const catalog = Array.isArray(venue?.bottle_price_list)
        ? (venue.bottle_price_list as Array<{
            key?: unknown;
            label?: unknown;
            price?: unknown;
          }>)
        : [];

      const selectedBottle = catalog.find(
        (item) => typeof item?.key === 'string' && item.key.trim() === bottleKey,
      );

      bottleName =
        typeof selectedBottle?.label === 'string' ? selectedBottle.label.trim() : '';
      unitPrice = Number(selectedBottle?.price ?? 0);

      if (!bottleName || !Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw new BadRequestException('Selected bottle is not available for this venue');
      }
    } else {
      if (!bottleName) {
        throw new BadRequestException('bottle_name is required');
      }
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw new BadRequestException('unit_price must be positive');
      }
    }

    const stationId = await this.resolveStationId({
      stationId: options?.stationId ?? dto.station_id ?? null,
      venueId: table.event.venue_id,
      stationType: VenueStationType.table,
    });

    const totalPrice = new Prisma.Decimal(unitPrice).mul(quantity);
    const shouldSettle = options?.autoSettle ?? dto.auto_settle ?? true;

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.table_bottle_orders.create({
        data: {
          event_table_id: tableId,
          requested_by_staff_id: options?.staffId ?? null,
          bottle_name: bottleName,
          quantity,
          unit_price: new Prisma.Decimal(unitPrice),
          total_price: totalPrice,
          note: dto.note?.trim() || null,
          status: TableBottleOrderStatus.requested,
        },
        select: { id: true },
      });

      await tx.table_sales.create({
        data: {
          event_id: table.event_id,
          event_table_id: tableId,
          staff_id: options?.staffId ?? null,
          station_id: stationId,
          amount: totalPrice,
          metadata: {
            type: 'bottle_order',
            bottle_order_id: order.id,
            bottle_key: bottleKey || null,
            bottle_name: bottleName,
            quantity,
            unit_price: unitPrice,
            total_price: unitPrice * quantity,
          },
        },
      });

      await tx.event_tables.update({
        where: { id: tableId },
        data: {
          pagato_totale: { increment: totalPrice },
          ...(shouldSettle ? { stato: 'saldato' } : {}),
        },
      });

      return order.id;
    });

    await this.eventsService.recalculateEventStats(table.event_id);

    return this.getBottleOrderById(result, table.event.venue_id);
  }

  async listBottleOrders(params: {
    eventId?: string;
    venueId?: string;
    status?: string;
  }) {
    const { eventId, venueId, status } = params;
    if (!eventId) {
      return [];
    }

    await this.ensureEventTablesSeeded(eventId);

    const normalizedStatus = String(status ?? '').trim().toLowerCase();
    const statusFilter =
      normalizedStatus === 'requested' ||
      normalizedStatus === 'preparing' ||
      normalizedStatus === 'delivered'
        ? (normalizedStatus as TableBottleOrderStatus)
        : undefined;

    const rows = await this.prisma.table_bottle_orders.findMany({
      where: {
        ...(statusFilter ? { status: statusFilter } : {}),
        event_table: {
          event_id: eventId,
          ...(venueId ? { venue_table: { venue_id: venueId } } : {}),
        },
      },
      orderBy: [{ created_at: 'desc' }],
      select: {
        id: true,
        event_table_id: true,
        requested_by_staff_id: true,
        prepared_by_staff_id: true,
        delivered_by_staff_id: true,
        bottle_name: true,
        quantity: true,
        unit_price: true,
        total_price: true,
        status: true,
        note: true,
        created_at: true,
        prepared_at: true,
        delivered_at: true,
        event_table: {
          select: {
            id: true,
            event_id: true,
            venue_table_id: true,
            assigned_number: true,
            prenotati: true,
            entrati: true,
            stato: true,
            venue_table: {
              select: {
                numero: true,
                nome: true,
                zona: true,
                venue_id: true,
              },
            },
          },
        },
      },
    });

    const tableNameByVenueTableId = await this.resolveReservationTableNames({
      eventId,
      venueId,
    });

    return rows.map((order) =>
      this.mapBottleOrder({
        ...order,
        event_table: {
          ...order.event_table,
          table_name: tableNameByVenueTableId.get(order.event_table.venue_table_id) ?? null,
        },
      }),
    );
  }

  async markBottleOrderPreparing(orderId: string, staffId?: string) {
    const existing = await this.prisma.table_bottle_orders.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        event_table: {
          select: {
            event: { select: { venue_id: true } },
          },
        },
      },
    });
    if (!existing) throw new NotFoundException('Bottle order not found');

    if (existing.status !== TableBottleOrderStatus.requested) {
      return this.getBottleOrderById(orderId, existing.event_table.event.venue_id);
    }

    await this.prisma.table_bottle_orders.update({
      where: { id: orderId },
      data: {
        status: TableBottleOrderStatus.preparing,
        prepared_by_staff_id: staffId ?? null,
        prepared_at: new Date(),
      },
    });

    return this.getBottleOrderById(orderId, existing.event_table.event.venue_id);
  }

  async markBottleOrderDelivered(orderId: string, staffId?: string) {
    const existing = await this.prisma.table_bottle_orders.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        event_table_id: true,
        event_table: {
          select: {
            stato: true,
            event: { select: { venue_id: true } },
          },
        },
      },
    });
    if (!existing) throw new NotFoundException('Bottle order not found');

    if (existing.status !== TableBottleOrderStatus.delivered) {
      await this.prisma.$transaction(async (tx) => {
        await tx.table_bottle_orders.update({
          where: { id: orderId },
          data: {
            status: TableBottleOrderStatus.delivered,
            delivered_by_staff_id: staffId ?? null,
            delivered_at: new Date(),
            ...(existing.status === TableBottleOrderStatus.requested
              ? {
                  prepared_by_staff_id: staffId ?? null,
                  prepared_at: new Date(),
                }
              : {}),
          },
        });

        if (String(existing.event_table.stato ?? '').toLowerCase() !== 'saldato') {
          await tx.event_tables.update({
            where: { id: existing.event_table_id },
            data: { stato: 'saldato' },
          });
        }
      });
    }

    return this.getBottleOrderById(orderId, existing.event_table.event.venue_id);
  }

  // Cameriere: salda il tavolo (segna come completamente pagato)
  async settleTable(tableId: string) {
    const table = await this.prisma.event_tables.findUnique({
      where: { id: tableId },
    });
    if (!table) throw new NotFoundException('Table not found');

    const updated = await this.prisma.event_tables.update({
      where: { id: tableId },
      data: {
        stato: 'saldato',
      },
    });

    return updated;
  }
}
