import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EntryMethod, Gender, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

type QrCheckInResult = {
  success: boolean;
  alreadyCheckedIn: boolean;
  reservation: unknown;
  entry?: unknown;
};

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

  async listBookedTableIdsForEvent(eventId: string): Promise<string[]> {
    const rows = await this.prisma.reservations.findMany({
      where: {
        event_id: eventId,
        type: 'table',
        // Cancelled reservations should not block the table.
        status: { not: 'cancelled' },
        venue_table_id: { not: null },
      },
      select: { venue_table_id: true },
    });

    const out = new Set<string>();
    for (const r of rows) {
      if (r.venue_table_id) out.add(r.venue_table_id);
    }
    return Array.from(out);
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
      qr_token: true,
      qr_payload: true,
      checked_in_at: true,
      checked_in_by_staff_id: true,
      checkin_entry_id: true,
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

  private buildEntryQrPayload(params: {
    reservationId: string;
    userId: string;
    eventId: string;
    qrToken: string;
  }) {
    return {
      v: 1,
      type: 'event_entry',
      reservation_id: params.reservationId,
      user_id: params.userId,
      event_id: params.eventId,
      qr_token: params.qrToken,
      issued_at: new Date().toISOString(),
    };
  }

  private parseQrData(raw: string): {
    qrToken?: string;
    reservationId?: string;
    userId?: string;
    eventId?: string;
  } {
    const value = String(raw ?? '').trim();
    if (!value) return {};

    if (value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        return {
          qrToken:
            (typeof parsed.qr_token === 'string' && parsed.qr_token) ||
            (typeof parsed.qrToken === 'string' && parsed.qrToken) ||
            (typeof parsed.token === 'string' && parsed.token) ||
            undefined,
          reservationId:
            (typeof parsed.reservation_id === 'string' && parsed.reservation_id) ||
            (typeof parsed.reservationId === 'string' && parsed.reservationId) ||
            undefined,
          userId:
            (typeof parsed.user_id === 'string' && parsed.user_id) ||
            (typeof parsed.userId === 'string' && parsed.userId) ||
            undefined,
          eventId:
            (typeof parsed.event_id === 'string' && parsed.event_id) ||
            (typeof parsed.eventId === 'string' && parsed.eventId) ||
            undefined,
        };
      } catch {
        return {};
      }
    }

    return { qrToken: value, userId: value };
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

    const existingReservationForEvent = await this.prisma.reservations.findFirst({
      where: {
        user_id: userId,
        event_id: eventId,
        status: { in: ['pending', 'confirmed', 'completed'] },
      },
      select: { id: true, type: true, status: true },
    });

    if (existingReservationForEvent) {
      throw new BadRequestException(
        'Hai già una prenotazione per questa serata',
      );
    }

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

    const qrToken = type === 'entry' ? randomUUID() : undefined;

    let created: any;
    try {
      created = await this.prisma.reservations.create({
        data: {
          user_id: userId,
          event_id: eventId,
          venue_table_id: type === 'table' ? venueTableId : null,
          type,
          status,
          guests,
          total_amount: totalAmount,
          qr_token: qrToken,
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
    } catch (error: any) {
      const prismaCode = error?.code;
      const errorMessage = String(error?.message ?? '').toLowerCase();
      if (
        prismaCode === 'P2002' ||
        errorMessage.includes('reservations_unique_active_user_event_idx') ||
        errorMessage.includes('duplicate key value violates unique constraint')
      ) {
        throw new BadRequestException('Hai già una prenotazione per questa serata');
      }
      throw error;
    }

    if (type !== 'entry' || !qrToken) return created;

    const qrPayload = JSON.stringify(
      this.buildEntryQrPayload({
        reservationId: created.id,
        userId,
        eventId,
        qrToken,
      }),
    );

    return this.prisma.reservations.update({
      where: { id: created.id },
      data: { qr_payload: qrPayload },
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

  async checkInEntryReservationByQr(params: {
    eventId: string;
    staffId: string;
    qrData: string;
  }): Promise<QrCheckInResult> {
    const eventId = String(params.eventId ?? '').trim();
    const staffId = String(params.staffId ?? '').trim();
    const qrData = String(params.qrData ?? '').trim();

    if (!eventId) throw new BadRequestException('event_id required');
    if (!staffId) throw new BadRequestException('staff_id required');
    if (!qrData) throw new BadRequestException('qr_data required');

    const parsed = this.parseQrData(qrData);

    let reservation =
      (parsed.qrToken
        ? await this.prisma.reservations.findUnique({
            where: { qr_token: parsed.qrToken },
            include: {
              user: { select: { id: true, sesso: true, name: true } },
              event: { select: { id: true, name: true, venue_id: true } },
            },
          })
        : null) ?? null;

    if (!reservation && parsed.reservationId) {
      reservation = await this.prisma.reservations.findUnique({
        where: { id: parsed.reservationId },
        include: {
          user: { select: { id: true, sesso: true, name: true } },
          event: { select: { id: true, name: true, venue_id: true } },
        },
      });
    }

    if (!reservation && parsed.userId) {
      reservation = await this.prisma.reservations.findFirst({
        where: {
          user_id: parsed.userId,
          event_id: eventId,
          type: 'entry',
          status: { in: ['pending', 'confirmed', 'completed'] },
        },
        orderBy: { created_at: 'desc' },
        include: {
          user: { select: { id: true, sesso: true, name: true } },
          event: { select: { id: true, name: true, venue_id: true } },
        },
      });
    }

    if (!reservation) {
      throw new NotFoundException('Reservation not found for this QR');
    }

    if (reservation.type !== 'entry') {
      throw new BadRequestException('QR is not linked to an entry reservation');
    }

    if (reservation.event_id !== eventId) {
      throw new BadRequestException('QR does not belong to this event');
    }

    if (reservation.status === 'cancelled') {
      throw new BadRequestException('Reservation cancelled');
    }

    if (reservation.checked_in_at) {
      return {
        success: true,
        alreadyCheckedIn: true,
        reservation,
      };
    }

    const gender =
      reservation.user?.sesso === 'M'
        ? Gender.M
        : reservation.user?.sesso === 'F'
          ? Gender.F
          : Gender.ALTRO;

    const result = await this.prisma.$transaction(async (tx) => {
      const createdEntry = await tx.entries.create({
        data: {
          event_id: eventId,
          user_id: reservation.user_id,
          staff_id: staffId,
          sesso: gender,
          price: new Prisma.Decimal(0),
          method: EntryMethod.QR,
        },
      });

      const updatedReservation = await tx.reservations.update({
        where: { id: reservation.id },
        data: {
          status: 'completed',
          checked_in_at: new Date(),
          checked_in_by_staff_id: staffId,
          checkin_entry_id: createdEntry.id,
        },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
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

      return { createdEntry, updatedReservation };
    });

    return {
      success: true,
      alreadyCheckedIn: false,
      reservation: result.updatedReservation,
      entry: result.createdEntry,
    };
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
