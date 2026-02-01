import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveVenueIdForUser(userId: string): Promise<string | null> {
    const u = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { venue_id: true },
    });
    return u?.venue_id ?? null;
  }

  async assertEventBelongsToVenue(eventId: string, venueId: string) {
    const event = await this.prisma.events.findFirst({
      where: { id: eventId, venue_id: venueId },
      select: { id: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found for this venue');
    }
  }

  private reservationSelect() {
    return {
      id: true,
      user_id: true,
      event_id: true,
      venue_table_id: true,
      type: true,
      status: true,
      guests: true,
      total_amount: true,
      created_at: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      },
      event: {
        select: {
          id: true,
          venue_id: true,
          name: true,
          date: true,
          start_time: true,
          end_time: true,
        },
      },
      venue_table: {
        select: {
          id: true,
          venue_id: true,
          nome: true,
          zona: true,
          numero: true,
          persone_max: true,
          per_testa: true,
          costo_minimo: true,
        },
      },
    } satisfies Prisma.reservationsSelect;
  }

  private normalizeCreateReservationDto(dto: any): {
    user_id?: string;
    event_id?: string;
    type?: 'table' | 'entry';
    guests?: unknown;
    venue_table_id?: string | null;
    status?: 'pending' | 'confirmed' | 'cancelled' | 'completed';
    total_amount?: unknown;
  } {
    const user_id = dto?.user_id ?? dto?.userId;
    const event_id = dto?.event_id ?? dto?.eventId;
    const type = dto?.type;
    const guests =
      dto?.guests ??
      dto?.guests_count ??
      dto?.guestsCount ??
      dto?.seats ??
      dto?.people;
    const venue_table_id =
      dto?.venue_table_id ??
      dto?.venueTableId ??
      dto?.table_id ??
      dto?.tableId ??
      null;
    const total_amount = dto?.total_amount ?? dto?.totalAmount;

    let status: any = dto?.status;
    if (status === 'reserved') status = 'confirmed';

    return {
      user_id,
      event_id,
      type,
      guests,
      venue_table_id,
      status,
      total_amount,
    };
  }

  private normalizeGuests(value: unknown): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new BadRequestException('guests must be an integer >= 1');
    }
    return n;
  }

  async listReservations(params?: {
    eventId?: string;
    userId?: string;
    venueId?: string;
    date?: string;
  }) {
    const where: Prisma.reservationsWhereInput = {};
    if (params?.eventId) where.event_id = params.eventId;
    if (params?.userId) where.user_id = params.userId;
    if (params?.venueId) where.event = { venue_id: params.venueId };
    // date filtering not supported by current schema (no date column)
    return this.prisma.reservations.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: this.reservationSelect(),
    });
  }

  async listReservationsPaginated(
    page: number,
    pageSize: number,
    params?: { eventId?: string; userId?: string; venueId?: string },
  ) {
    const take = Math.max(pageSize, 1);
    const skip = (Math.max(page, 1) - 1) * take;

    const where: Prisma.reservationsWhereInput = {};
    if (params?.eventId) where.event_id = params.eventId;
    if (params?.userId) where.user_id = params.userId;
    if (params?.venueId) where.event = { venue_id: params.venueId };

    const [total, data] = await this.prisma.$transaction([
      this.prisma.reservations.count({ where }),
      this.prisma.reservations.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take,
        select: this.reservationSelect(),
      }),
    ]);

    return {
      data,
      total,
      page: Math.max(page, 1),
      pageSize: take,
      hasMore: skip + data.length < total,
    };
  }

  async getReservation(id: string) {
    const r = await this.prisma.reservations.findUnique({
      where: { id },
      select: this.reservationSelect(),
    });
    if (!r) throw new NotFoundException('Reservation not found');
    return r;
  }

  async createReservation(dto: any) {
    const normalized = this.normalizeCreateReservationDto(dto);

    const userId: string | undefined = normalized.user_id;
    const eventId: string | undefined = normalized.event_id;
    const type: 'table' | 'entry' | undefined = normalized.type;

    if (!userId) throw new BadRequestException('user_id required');
    if (!eventId) throw new BadRequestException('event_id required');
    if (type !== 'table' && type !== 'entry') {
      throw new BadRequestException('type must be "table" or "entry"');
    }

    const guests = this.normalizeGuests(normalized.guests);

    const event = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { id: true, venue_id: true },
    });
    if (!event) throw new NotFoundException('Event not found');

    const venueTableId: string | null | undefined = normalized.venue_table_id ?? null;

    let totalAmount: Prisma.Decimal | undefined;
    if (normalized?.total_amount !== null && normalized?.total_amount !== undefined) {
      const n = Number(normalized.total_amount);
      if (!Number.isFinite(n) || n < 0) {
        throw new BadRequestException('total_amount must be a number >= 0');
      }
      totalAmount = new Prisma.Decimal(n);
    }

    if (type === 'table') {
      if (!venueTableId) {
        throw new BadRequestException('venue_table_id required for table reservations');
      }

      const table = await this.prisma.venue_tables.findUnique({
        where: { id: venueTableId },
        select: {
          id: true,
          venue_id: true,
          per_testa: true,
          costo_minimo: true,
          persone_max: true,
        },
      });
      if (!table) throw new NotFoundException('Table not found');
      if (table.venue_id !== event.venue_id) {
        throw new BadRequestException('Selected table does not belong to this event venue');
      }
      if (table.persone_max && guests > table.persone_max) {
        throw new BadRequestException('guests exceeds table persone_max');
      }

      // Auto compute total_amount if missing and per_testa is available
      if (!totalAmount && table.per_testa) {
        try {
          totalAmount = table.per_testa.mul(new Prisma.Decimal(guests));
        } catch {
          // ignore
        }
      }
    }

    const status = normalized?.status;
    if (
      status !== undefined &&
      status !== 'pending' &&
      status !== 'confirmed' &&
      status !== 'cancelled' &&
      status !== 'completed'
    ) {
      throw new BadRequestException('status must be pending|confirmed|cancelled|completed');
    }

    return await this.prisma.reservations.create({
      data: {
        user_id: userId,
        event_id: eventId,
        venue_table_id: type === 'table' ? venueTableId : null,
        type,
        status,
        guests,
        total_amount: totalAmount,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        event: {
          select: {
            id: true,
            venue_id: true,
            name: true,
            date: true,
            start_time: true,
            end_time: true,
          },
        },
        venue_table: true,
      },
    });
  }

  async updateReservation(id: string, updates: any) {
    await this.getReservation(id);
    return this.prisma.reservations.update({
      where: { id },
      data: updates,
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true },
        },
        event: {
          select: {
            id: true,
            venue_id: true,
            name: true,
            date: true,
            start_time: true,
            end_time: true,
          },
        },
        venue_table: true,
      },
    });
  }

  async cancelReservation(id: string) {
    await this.getReservation(id);
    return this.prisma.reservations.update({
      where: { id },
      data: { status: 'cancelled' },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true },
        },
        event: {
          select: {
            id: true,
            venue_id: true,
            name: true,
            date: true,
            start_time: true,
            end_time: true,
          },
        },
        venue_table: true,
      },
    });
  }
}
