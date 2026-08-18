import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
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
import { BadgesService } from '../badges/badges.service';
import { RecordEntryDto } from './dto/record-entry.dto';
import { RecordSaleDto } from './dto/record-sale.dto';
import { UpdateTableHostessDto } from './dto/update-table-hostess.dto';
import { EventsService } from '../events/events.service';
import { resolveEntryUnitPrice } from '../common/entry-pricing';
import { CreateTableBottleOrderDto } from './dto/create-table-bottle-order.dto';
import { PushDispatchService } from '../common/push/push-dispatch.service';

@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsService: EventsService,
    private readonly badgesService: BadgesService,
    private readonly pushDispatch: PushDispatchService,
  ) {}

  private evaluateBadges(userId: string | null | undefined) {
    if (!userId) return;
    void this.badgesService.evaluateForUser(userId).catch(() => {});
  }

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
        throw new BadRequestException(
          'station_id does not belong to the event venue',
        );
      }
      if (station.station_type !== params.stationType) {
        throw new BadRequestException(
          'station_id does not match the sale type',
        );
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
    expectedVenueId?: string;
  }): Promise<string> {
    const { eventId, venueId, staffId, eventTableId, expectedVenueId } = params;

    if (eventId) {
      // Existence + venue-ownership check combined into the one query instead of the
      // caller doing a separate `assertEventBelongsToVenue` round trip afterward - this is
      // the only branch where an explicit venue check is meaningful (the venueId/staffId
      // branches below already resolve an event scoped to that venue by construction).
      await this.ensureEvent(eventId, expectedVenueId);
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
    expectedVenueId?: string;
  }): Promise<string> {
    return this.resolveEventId(params);
  }

  private async ensureEvent(event_id: string, expectedVenueId?: string) {
    const exists = await this.prisma.events.findUnique({
      where: { id: event_id },
      select: { id: true, venue_id: true },
    });
    if (!exists) throw new NotFoundException('Event not found');
    if (expectedVenueId && exists.venue_id !== expectedVenueId) {
      throw new ForbiddenException('Forbidden');
    }
  }

  // A table reservation targets a zone directly (`venue_table_zone_id`) and that IS the
  // assignment - there's no physical "venue_tables" step anymore. `event_tables` is keyed
  // per (event, zone) instead of per (event, physical table).
  private async ensureEventTablesSeeded(eventId: string) {
    if (!eventId) return;

    // All four reads are independent of each other. `venueZones` used to wait for `event`
    // to resolve first (it needed `event.venue_id`) - filtering through the `venue.events`
    // relation instead lets it query by `eventId` directly, so all 4 now run in a single
    // `Promise.all` instead of 2 sequential batches.
    const [event, existingEventTables, venueZones, grouped, groupedArrived] =
      await Promise.all([
        this.prisma.events.findUnique({
          where: { id: eventId },
          select: { id: true, venue_id: true },
        }),
        this.prisma.event_tables.findMany({
          where: { event_id: eventId },
          select: {
            id: true,
            venue_table_zone_id: true,
            prenotati: true,
            entrati: true,
          },
        }),
        this.prisma.venue_table_zones.findMany({
          where: { venue: { events: { some: { id: eventId } } } },
          select: { id: true },
        }),
        this.prisma.reservations.groupBy({
          by: ['venue_table_zone_id'],
          where: {
            event_id: eventId,
            type: 'table',
            status: { in: ['pending', 'confirmed', 'completed'] },
            venue_table_zone_id: { not: null },
          },
          _sum: { guests: true },
        }),
        // `entrati` mirrors the headcount of reservations the hostess has actually checked
        // in (status `completed`, set via ReservationsService.checkinTableReservation) - it's
        // no longer a standalone manual tally, so it stays consistent with `reservations`.
        // Uses `actual_guests` when the hostess corrected the headcount at check-in time
        // (e.g. booked 7, only 5 showed up), falling back to the originally booked `guests`
        // otherwise - a plain Prisma `_sum` can't express that per-row fallback.
        this.prisma.$queryRaw<
          { venue_table_zone_id: string; total: bigint | number }[]
        >(Prisma.sql`
          SELECT venue_table_zone_id, SUM(COALESCE(actual_guests, guests)) AS total
          FROM reservations
          WHERE event_id = ${eventId}::uuid
            AND type = 'table'
            AND status = 'completed'
            AND venue_table_zone_id IS NOT NULL
          GROUP BY venue_table_zone_id
        `),
      ]);
    if (!event) throw new NotFoundException('Event not found');

    const venueZoneCount = venueZones.length;
    if (!venueZoneCount) return;

    const prenotatiByZoneId = new Map<string, number>();
    for (const g of grouped) {
      const zoneId = g.venue_table_zone_id;
      if (!zoneId) continue;
      prenotatiByZoneId.set(zoneId, Number(g._sum.guests ?? 0));
    }

    const entratiByZoneId = new Map<string, number>();
    for (const row of groupedArrived) {
      if (!row.venue_table_zone_id) continue;
      entratiByZoneId.set(row.venue_table_zone_id, Number(row.total ?? 0));
    }

    const selectedZoneIds =
      existingEventTables.length > 0
        ? existingEventTables.map((row) => row.venue_table_zone_id)
        : venueZones.map((zone) => zone.id);

    if (existingEventTables.length === 0) {
      // Rows are seeded with the correct `prenotati`/`entrati` inline, so there's nothing to
      // reconcile afterward for this branch - no need to re-fetch what was just written.
      await this.prisma.event_tables.createMany({
        data: selectedZoneIds.map((zoneId) => ({
          event_id: eventId,
          venue_table_zone_id: zoneId,
          prenotati: prenotatiByZoneId.get(zoneId) ?? 0,
          entrati: entratiByZoneId.get(zoneId) ?? 0,
          pagato_totale: 0,
          stato: 'libero',
        })),
        skipDuplicates: true,
      });
      return;
    }

    // Sync prenotati/entrati for existing rows (idempotent). Nothing wrote to event_tables
    // between the fetch above and here (the createMany branch above always returns early),
    // so reuse that fetch instead of re-querying the same rows.
    const updates: Array<Prisma.PrismaPromise<unknown>> = [];
    for (const row of existingEventTables) {
      const desiredPrenotati =
        prenotatiByZoneId.get(row.venue_table_zone_id) ?? 0;
      const desiredEntrati = entratiByZoneId.get(row.venue_table_zone_id) ?? 0;
      const data: Record<string, number> = {};
      if ((row.prenotati ?? 0) !== desiredPrenotati)
        data.prenotati = desiredPrenotati;
      if ((row.entrati ?? 0) !== desiredEntrati) data.entrati = desiredEntrati;
      if (Object.keys(data).length) {
        updates.push(
          this.prisma.event_tables.update({ where: { id: row.id }, data }),
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

  private normalizeGenderInput(
    gender?: RecordEntryDto['gender'],
  ): Gender | null {
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
      dto.is_complimentary ??
      (dto.entry_type ? dto.entry_type === 'free' : false);
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
    this.evaluateBadges(dto.user_id ?? null);
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
      const event = await this.prisma.events.findUnique({
        where: { id: eventId },
        select: {
          venue: {
            select: {
              id: true,
              name: true,
              latitude: true,
              longitude: true,
              radius_geofence: true,
            },
          },
        },
      });

      const venue = event?.venue ?? null;
      const latitude = venue?.latitude ? Number(venue.latitude) : null;
      const longitude = venue?.longitude ? Number(venue.longitude) : null;
      const radius = venue?.radius_geofence ?? 100;

      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        venue?.id
      ) {
        await this.pushDispatch.notifyUser(dto.user_id, {
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
    }).catch((error: unknown) => {
      // The sale itself already succeeded above - this only resolves the event id to
      // recalculate its stats, so a failure here must not fail the whole request. Logged
      // (rather than silently discarded) so a caller polling `stats` afterward has a trail
      // to follow when it unexpectedly comes back null.
      this.logger.warn(
        `recordSale: failed to resolve event id for stats recalculation: ${String(error)}`,
      );
      return undefined;
    });

    const stats = resolvedEventId
      ? await this.eventsService.recalculateEventStats(resolvedEventId)
      : null;

    return { sale, stats };
  }

  // These lists are polled by staff UIs and are otherwise unbounded on append-only tables.
  // `take` here is a safety net (well above any single event's realistic volume), not a
  // real pagination UX — full pagination is a larger, separate change.
  private static readonly MAX_LIST_ROWS = 5000;

  async listEntries(eventId?: string) {
    return this.prisma.entries.findMany({
      where: eventId ? { event_id: eventId } : undefined,
      orderBy: { created_at: 'desc' },
      take: StaffService.MAX_LIST_ROWS,
    });
  }

  async listBarSales(eventId?: string) {
    return this.prisma.bar_sales.findMany({
      where: eventId ? { event_id: eventId } : undefined,
      orderBy: { created_at: 'desc' },
      take: StaffService.MAX_LIST_ROWS,
    });
  }

  async listCloakroomSales(eventId?: string) {
    return this.prisma.cloakroom_sales.findMany({
      where: eventId ? { event_id: eventId } : undefined,
      orderBy: { created_at: 'desc' },
      take: StaffService.MAX_LIST_ROWS,
    });
  }

  async listTableSales(eventId?: string) {
    return this.prisma.table_sales.findMany({
      where: eventId ? { event_table: { event_id: eventId } } : undefined,
      orderBy: { created_at: 'desc' },
      take: StaffService.MAX_LIST_ROWS,
    });
  }

  private mapBottleOrder(order: any) {
    const tableLabel =
      order.event_table?.assigned_number ??
      order.event_table?.venue_table_zone?.sort_order ??
      null;

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
            nome: order.event_table.venue_table_zone?.name ?? 'Tavolo',
            zona: order.event_table.venue_table_zone?.name ?? null,
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
            venue_table_zone_id: true,
            assigned_number: true,
            prenotati: true,
            entrati: true,
            stato: true,
            venue_table_zone: {
              select: {
                name: true,
                sort_order: true,
                venue_id: true,
              },
            },
          },
        },
      },
    });

    if (!order) throw new NotFoundException('Bottle order not found');
    if (venueId && order.event_table.venue_table_zone?.venue_id !== venueId) {
      throw new ForbiddenException('Forbidden');
    }

    const tableNameByZoneId = await this.resolveReservationTableNames({
      eventId: order.event_table.event_id,
      venueId,
    });

    return this.mapBottleOrder({
      ...order,
      event_table: {
        ...order.event_table,
        table_name:
          tableNameByZoneId.get(order.event_table.venue_table_zone_id) ?? null,
      },
    });
  }

  private async resolveReservationTableNames(params: {
    eventId: string;
    venueId?: string;
  }): Promise<Map<string, string>> {
    const { eventId, venueId } = params;

    const venueFilter = venueId
      ? Prisma.sql`AND vtz.venue_id = ${venueId}::uuid`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<
      Array<{ venue_table_zone_id: string | null; table_name: string | null }>
    >(Prisma.sql`
      SELECT r.venue_table_zone_id, r.table_name
      FROM reservations r
      JOIN venue_table_zones vtz ON vtz.id = r.venue_table_zone_id
      WHERE r.event_id = ${eventId}::uuid
        AND r.type = 'table'
        AND r.status IN ('pending', 'confirmed', 'completed')
        AND r.table_name IS NOT NULL
        AND BTRIM(r.table_name) <> ''
        ${venueFilter}
      ORDER BY r.created_at DESC
    `);

    const tableNameByZoneId = new Map<string, string>();
    for (const row of rows) {
      const zoneId = row?.venue_table_zone_id
        ? String(row.venue_table_zone_id)
        : '';
      const tableName = row?.table_name ? String(row.table_name).trim() : '';
      if (!zoneId || !tableName) continue;
      if (!tableNameByZoneId.has(zoneId)) {
        tableNameByZoneId.set(zoneId, tableName);
      }
    }

    return tableNameByZoneId;
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

    // The reservations aggregate doesn't depend on ensureEventTablesSeeded's writes (it
    // reads `reservations`, not `event_tables`), so it runs alongside the seeding instead
    // of waiting for it.
    const [, groupedReservations] = await Promise.all([
      this.ensureEventTablesSeeded(eventId),
      this.prisma.reservations.groupBy({
        by: ['venue_table_zone_id'],
        where: {
          event_id: eventId,
          type: 'table',
          status: 'confirmed',
          venue_table_zone_id: { not: null },
          ...(venueId ? { venue_table_zone: { venue_id: venueId } } : {}),
        },
        _sum: { guests: true },
      }),
    ]);

    const prenotatiByZoneId = new Map<string, number>();
    for (const reservation of groupedReservations) {
      const zoneId = reservation.venue_table_zone_id;
      if (!zoneId) continue;
      prenotatiByZoneId.set(zoneId, Number(reservation._sum.guests ?? 0));
    }

    const bookedZoneIds = Array.from(prenotatiByZoneId.keys());
    if (!bookedZoneIds.length) {
      return [];
    }

    // Independent of each other (table_name resolution reads `reservations`, not the
    // `event_tables` rows being fetched here), so they run concurrently.
    const [tables, tableNameByZoneId] = await Promise.all([
      this.prisma.event_tables.findMany({
        where: {
          event_id: eventId,
          venue_table_zone_id: { in: bookedZoneIds },
          ...(includeConfirmed ? {} : { confermato: false }),
          ...(venueId ? { venue_table_zone: { venue_id: venueId } } : {}),
        },
        include: { venue_table_zone: true, event: true },
        orderBy: [{ venue_table_zone: { sort_order: 'asc' } }],
      }),
      this.resolveReservationTableNames({ eventId, venueId }),
    ]);

    return tables.map((t) => {
      const prenotati = prenotatiByZoneId.get(t.venue_table_zone_id) ?? 0;
      const per_testa =
        t.per_testa_override ?? t.venue_table_zone?.per_testa ?? 0;
      const costo_minimo =
        t.costo_minimo_override ?? t.venue_table_zone?.costo_minimo ?? null;
      const stato =
        t.entrati >= prenotati
          ? 'completo'
          : t.entrati > 0
            ? 'parziale'
            : 'attesa';
      // spesa_minima is the guaranteed table spend (headcount actually walked in x cost per
      // head); pagato_totale only ever holds extras the waiter adds on top (table_sales,
      // bottle_orders, addTablePayment) - it's never seeded with the minimum itself. The
      // amount the venue actually collects is the two added together.
      const spesa_minima = this.toNumber(per_testa) * t.entrati;
      const totale_incassato = spesa_minima + this.toNumber(t.pagato_totale);

      return {
        id: t.id,
        event_id: t.event_id,
        venue_table_zone_id: t.venue_table_zone_id,
        table_name: tableNameByZoneId.get(t.venue_table_zone_id) ?? null,
        prenotati,
        entrati: t.entrati,
        pagato_totale: t.pagato_totale,
        spesa_minima,
        totale_incassato,
        per_testa,
        costo_minimo,
        confermato: Boolean((t as any).confermato),
        stato,
        numero: t.assigned_number ?? null,
        venue_table_zone: t.venue_table_zone,
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

    // Table-name resolution reads `reservations`, independent of ensureEventTablesSeeded's
    // writes to `event_tables`, so it runs alongside the seeding instead of after it.
    const [, tableNameByZoneId] = await Promise.all([
      this.ensureEventTablesSeeded(eventId),
      this.resolveReservationTableNames({ eventId, venueId }),
    ]);

    const rows = await this.prisma.event_tables.findMany({
      where: {
        event_id: eventId,
        ...(venueId ? { venue_table_zone: { venue_id: venueId } } : {}),
        ...(onlyBooked ? { prenotati: { gt: 0 } } : {}),
      },
      select: {
        id: true,
        event_id: true,
        venue_table_zone_id: true,
        assigned_number: true,
        per_testa_override: true,
        costo_minimo_override: true,
        venue_table_zone: {
          select: {
            venue_id: true,
            name: true,
            per_testa: true,
            costo_minimo: true,
            sort_order: true,
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
      orderBy: [{ venue_table_zone: { sort_order: 'asc' } }],
    });

    return rows.map((t) => {
      const is_saldato = (t.stato ?? '').toLowerCase() === 'saldato';
      const pagato_totale = t.pagato_totale;
      const per_testa =
        t.per_testa_override ?? t.venue_table_zone?.per_testa ?? 0;
      const costo_minimo =
        t.costo_minimo_override ?? t.venue_table_zone?.costo_minimo ?? null;
      // spesa_minima is the guaranteed table spend (headcount actually walked in x cost per
      // head); pagato_totale only ever holds extras the waiter adds on top (table_sales,
      // bottle_orders, addTablePayment). What the venue actually collects is both added
      // together.
      const spesa_minima = this.toNumber(per_testa) * (t.entrati ?? 0);
      const totale_incassato = spesa_minima + this.toNumber(pagato_totale);

      return {
        id: t.id,
        event_id: t.event_id,
        venue_id: t.venue_table_zone?.venue_id ?? null,
        nome: t.venue_table_zone?.name ?? 'Tavolo',
        table_name: tableNameByZoneId.get(t.venue_table_zone_id) ?? null,
        zona: t.venue_table_zone?.name ?? null,
        per_testa,
        costo_minimo,
        prenotati: t.prenotati ?? 0,
        entrati: t.entrati ?? 0,
        numero: t.assigned_number ?? null,
        pagato_iniziale: null,
        pagato_totale,
        spesa_minima,
        totale_incassato,
        stato_pagamento: is_saldato
          ? 'saldato'
          : totale_incassato > 0
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

  // Manual tap +/-1. Note `entrati` is now derived from checked-in reservations
  // (see ensureEventTablesSeeded), so any manual change here is overwritten on the next
  // hostess/waiter table list fetch - kept only for backward compatibility with old clients.
  async updateHostessTableEntrati(id: string, delta: number) {
    if (!delta) throw new BadRequestException('delta must be non-zero');

    // Lock the row for the duration of the read-modify-write so concurrent door-scan
    // updates to the same table can't lose an increment/decrement.
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string; entrati: number; prenotati: number }[]
      >(Prisma.sql`
        SELECT id, entrati, prenotati
        FROM event_tables
        WHERE id = ${id}
        FOR UPDATE
      `);
      const table = locked[0];
      if (!table) throw new NotFoundException('Table not found');

      const next = Number(table.entrati ?? 0) + delta;
      if (next < 0) throw new BadRequestException('entrati cannot be negative');

      return tx.event_tables.update({
        where: { id },
        data: {
          entrati: next,
          ...(next < Number(table.prenotati ?? 0) ? { confermato: false } : {}),
        },
      });
    });
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
      include: { venue_table_zone: true },
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
      include: { venue_table_zone: true },
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
      // Overwritten on the next list fetch - see updateHostessTableEntrati.
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
        (item) =>
          typeof item?.key === 'string' && item.key.trim() === bottleKey,
      );

      bottleName =
        typeof selectedBottle?.label === 'string'
          ? selectedBottle.label.trim()
          : '';
      unitPrice = Number(selectedBottle?.price ?? 0);

      if (!bottleName || !Number.isFinite(unitPrice) || unitPrice <= 0) {
        throw new BadRequestException(
          'Selected bottle is not available for this venue',
        );
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

    const normalizedStatus = String(status ?? '')
      .trim()
      .toLowerCase();
    const statusFilter =
      normalizedStatus === 'requested' ||
      normalizedStatus === 'preparing' ||
      normalizedStatus === 'delivered'
        ? (normalizedStatus as TableBottleOrderStatus)
        : undefined;

    // Bottle orders only ever reference event_tables that already exist (created at
    // order-creation time, which does its own seeding), and table-name resolution reads
    // `reservations` - neither depends on ensureEventTablesSeeded's writes, so all three
    // run concurrently instead of seeding-then-fetch-then-fetch.
    const [, rows, tableNameByZoneId] = await Promise.all([
      this.ensureEventTablesSeeded(eventId),
      this.prisma.table_bottle_orders.findMany({
        where: {
          ...(statusFilter ? { status: statusFilter } : {}),
          event_table: {
            event_id: eventId,
            ...(venueId ? { venue_table_zone: { venue_id: venueId } } : {}),
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
              venue_table_zone_id: true,
              assigned_number: true,
              prenotati: true,
              entrati: true,
              stato: true,
              venue_table_zone: {
                select: {
                  name: true,
                  sort_order: true,
                  venue_id: true,
                },
              },
            },
          },
        },
      }),
      this.resolveReservationTableNames({ eventId, venueId }),
    ]);

    return rows.map((order) =>
      this.mapBottleOrder({
        ...order,
        event_table: {
          ...order.event_table,
          table_name:
            tableNameByZoneId.get(order.event_table.venue_table_zone_id) ??
            null,
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
      return this.getBottleOrderById(
        orderId,
        existing.event_table.event.venue_id,
      );
    }

    await this.prisma.table_bottle_orders.update({
      where: { id: orderId },
      data: {
        status: TableBottleOrderStatus.preparing,
        prepared_by_staff_id: staffId ?? null,
        prepared_at: new Date(),
      },
    });

    return this.getBottleOrderById(
      orderId,
      existing.event_table.event.venue_id,
    );
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

        if (
          String(existing.event_table.stato ?? '').toLowerCase() !== 'saldato'
        ) {
          await tx.event_tables.update({
            where: { id: existing.event_table_id },
            data: { stato: 'saldato' },
          });
        }
      });
    }

    return this.getBottleOrderById(
      orderId,
      existing.event_table.event.venue_id,
    );
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
