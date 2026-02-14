import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EntryMethod,
  Gender,
  Prisma,
  bar_sales,
  cloakroom_sales,
  table_sales,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RecordEntryDto } from './dto/record-entry.dto';
import { RecordSaleDto } from './dto/record-sale.dto';
import { UpdateTableHostessDto } from './dto/update-table-hostess.dto';
import { EventsService } from '../events/events.service';

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

    const venueTableCount = venueTables.length;
    if (!venueTableCount) return;

    // Fast path: if already fully seeded, avoid groupBy + sync work on every request.
    const existingCount = await this.prisma.event_tables.count({
      where: { event_id: eventId },
    });
    if (existingCount >= venueTableCount && existingCount > 0) {
      return;
    }

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

    // Ensure event_tables rows exist for every venue table
    await this.prisma.event_tables.createMany({
      data: venueTables.map((vt) => ({
        event_id: eventId,
        venue_table_id: vt.id,
        prenotati: prenotatiByVenueTableId.get(vt.id) ?? 0,
        entrati: 0,
        pagato_totale: 0,
        stato: 'libero',
      })),
      skipDuplicates: true,
    });

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

  private async sendExpoPush(params: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }) {
    const token = params.token || '';
    const isExpoToken =
      token.startsWith('ExponentPushToken') || token.startsWith('ExpoPushToken');
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
      throw new BadRequestException('quantity must be 1 when user_id is provided');
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

    const sesso = this.entryTypeToGender(dto.entry_type ?? 'free');
    const method = dto.user_id ? EntryMethod.QR : EntryMethod.RAPIDO;
    const createData: Prisma.entriesCreateManyInput[] = Array.from(
      { length: quantity },
      () => ({
        event_id: eventId,
        staff_id: dto.staff_id ?? null,
        user_id: dto.user_id ?? null,
        sesso,
        price: new Prisma.Decimal(0),
        method,
      }),
    );

    await this.prisma.entries.createMany({ data: createData });
    const stats = await this.eventsService.recalculateEventStats(eventId);

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

      if (kind === 'bar') {
        sale = await this.prisma.bar_sales.create({
          data: {
            event_id: eventId,
            amount: dto.amount,
          },
        });
      } else {
        sale = await this.prisma.cloakroom_sales.create({
          data: {
            event_id: eventId,
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

      sale = await this.prisma.table_sales.create({
        data: {
          event_table_id: dto.event_table_id,
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

  // Hostess tables
  async listHostessTables(params: {
    eventId?: string;
    venueId?: string;
    onlyBooked?: boolean;
  }) {
    const { eventId, venueId, onlyBooked } = params;

    if (eventId) {
      await this.ensureEventTablesSeeded(eventId);
    }

    const tables = await this.prisma.event_tables.findMany({
      where: {
        ...(eventId ? { event_id: eventId } : {}),
        ...(venueId ? { venue_table: { venue_id: venueId } } : {}),
        ...(onlyBooked ? { prenotati: { gt: 0 } } : {}),
      },
      include: { venue_table: true, event: true },
      orderBy: [{ venue_table: { numero: 'asc' } }],
    });

    return tables.map((t) => ({
      ...t,
      stato:
        t.entrati >= (t.prenotati ?? 0)
          ? 'completo'
          : t.entrati > 0
            ? 'parziale'
            : 'attesa',
    }));
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
        venue_table: {
          select: {
            venue_id: true,
            nome: true,
            zona: true,
            per_testa: true,
            numero: true,
          },
        },
        prenotati: true,
        entrati: true,
        pagato_totale: true,
        stato: true,
        table_sales: { orderBy: { created_at: 'desc' }, take: 50 },
      },
      orderBy: [{ venue_table: { numero: 'asc' } }],
    });

    return rows.map((t) => {
      const is_saldato = (t.stato ?? '').toLowerCase() === 'saldato';
      const pagato_totale = t.pagato_totale;

      return {
        id: t.id,
        event_id: t.event_id,
        venue_id: t.venue_table?.venue_id ?? null,
        nome: t.venue_table?.nome ?? 'Tavolo',
        zona: t.venue_table?.zona ?? null,
        per_testa: t.venue_table?.per_testa ?? 0,
        prenotati: t.prenotati ?? 0,
        entrati: t.entrati ?? 0,
        numero: t.venue_table?.numero ?? null,
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
      data: { entrati: next },
    });
    return updated;
  }

  async assignHostessTableNumber(id: string, numero: number) {
    if (!Number.isFinite(numero))
      throw new BadRequestException('numero must be a valid number');
    const table = await this.prisma.event_tables.findUnique({
      where: { id },
      include: { venue_table: true },
    });
    if (!table) throw new NotFoundException('Table not found');

    const updatedVenueTable = await this.prisma.venue_tables.update({
      where: { id: table.venue_table_id },
      data: { numero },
    });

    return { ...table, venue_table: updatedVenueTable };
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
  async addTablePayment(tableId: string, amount: number) {
    const table = await this.prisma.event_tables.findUnique({
      where: { id: tableId },
    });
    if (!table) throw new NotFoundException('Table not found');

    if (amount <= 0) {
      throw new BadRequestException('amount must be positive');
    }

    // Crea record in table_sales
    const sale = await this.prisma.table_sales.create({
      data: {
        event_table_id: tableId,
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
