import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Headers,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import { assertCronSecret } from '../common/cron-auth.util';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  private parseOptionalGuests(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    const guests = Number(value);
    if (!Number.isInteger(guests) || guests < 1) {
      throw new BadRequestException('guests must be an integer >= 1');
    }
    return guests;
  }

  private parseOptionalTableName(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException('table_name must be a string');
    }

    const tableName = String(value).trim();
    if (!tableName.length) return null;
    if (tableName.length > 60) {
      throw new BadRequestException('table_name must be <= 60 chars');
    }
    return tableName;
  }

  private parseOptionalTotalAmount(value: unknown): number | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;

    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException('total_amount must be a number >= 0');
    }

    return amount;
  }

  private parseOptionalStatus(
    value: unknown,
  ): 'pending' | 'confirmed' | 'cancelled' | 'completed' | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new BadRequestException(
        'status must be pending|confirmed|cancelled|completed',
      );
    }

    const status = value.trim().toLowerCase();
    if (
      status === 'pending' ||
      status === 'confirmed' ||
      status === 'cancelled' ||
      status === 'completed'
    ) {
      return status;
    }

    throw new BadRequestException(
      'status must be pending|confirmed|cancelled|completed',
    );
  }

  @Get()
  @Roles('client', 'venue', 'staff', 'admin')
  list(
    @CurrentUser() user: RequestUser,
    @Query('event_id') eventIdSnake?: string,
    @Query('eventId') eventIdCamel?: string,
    @Query('user_id') userIdSnake?: string,
    @Query('userId') userIdCamel?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const eventId = eventIdSnake ?? eventIdCamel;
    const userId = userIdSnake ?? userIdCamel;

    // Clients can only see their own reservations (optionally filtered by event).
    if (user.role === 'client') {
      if (page || pageSize) {
        const pageNum = page ? parseInt(page, 10) || 1 : 1;
        const pageSizeNum = pageSize ? parseInt(pageSize, 10) || 20 : 20;
        return this.reservationsService.listReservationsPaginated(
          pageNum,
          pageSizeNum,
          {
            eventId,
            userId: user.id,
          },
        );
      }
      return this.reservationsService.listReservations({
        eventId,
        userId: user.id,
      });
    }

    // Admin can query with explicit filters (keeps existing behavior for ops).
    if (user.role === 'admin') {
      if (page || pageSize) {
        const pageNum = page ? parseInt(page, 10) || 1 : 1;
        const pageSizeNum = pageSize ? parseInt(pageSize, 10) || 20 : 20;
        return this.reservationsService.listReservationsPaginated(
          pageNum,
          pageSizeNum,
          {
            eventId,
            userId,
          },
        );
      }
      return this.reservationsService.listReservations({ eventId, userId });
    }

    // Venue: must be scoped to their venue AND to the requested event.
    if (!eventId) throw new BadRequestException('event_id required');

    const venueId = user.venue_id ?? undefined;
    if (!venueId)
      throw new ForbiddenException('Missing venue_id for this user');
    return (async () => {
      await this.reservationsService.assertEventBelongsToVenue(
        eventId,
        venueId,
      );

      if (page || pageSize) {
        const pageNum = page ? parseInt(page, 10) || 1 : 1;
        const pageSizeNum = pageSize ? parseInt(pageSize, 10) || 20 : 20;
        return this.reservationsService.listReservationsPaginated(
          pageNum,
          pageSizeNum,
          {
            eventId,
            venueId,
          },
        );
      }

      return this.reservationsService.listReservations({ eventId, venueId });
    })();
  }

  // Kept for backward compatibility with older clients - physical tables no longer exist
  // in the booking flow (reservations target a zone directly, see `booked-zones` below),
  // so there is never anything to report here.
  @Get('booked-tables')
  @Public()
  bookedTables(
    @Query('event_id') eventIdSnake?: string,
    @Query('eventId') eventIdCamel?: string,
  ) {
    const eventId = eventIdSnake ?? eventIdCamel;
    if (!eventId) throw new BadRequestException('event_id required');
    return [];
  }

  @Get('booked-zones')
  @Public()
  bookedZones(
    @Query('event_id') eventIdSnake?: string,
    @Query('eventId') eventIdCamel?: string,
  ) {
    const eventId = eventIdSnake ?? eventIdCamel;
    if (!eventId) throw new BadRequestException('event_id required');
    return this.reservationsService.listBookedZoneIdsForEvent(eventId);
  }

  @Get('table-invitations/incoming')
  @Roles('client')
  listIncomingTableInvitations(@CurrentUser() user: RequestUser) {
    return this.reservationsService.listIncomingTableInvitations(user.id);
  }

  // Called by an external scheduler (Vercel Cron) with a shared secret, same pattern as
  // GET /events/sync-status. Expires `pending` reservations the venue never responded to,
  // so they don't sit open forever with no operational signal.
  @Get('sync-status')
  @Public()
  async syncStatus(
    @Query('token') token?: string,
    @Headers('x-cron-secret') headerSecret?: string,
    @Headers('authorization') authorization?: string,
  ) {
    assertCronSecret({ token, headerSecret, authorization });
    return this.reservationsService.expireStalePendingReservations();
  }

  @Get(':id')
  @Roles('client', 'venue', 'staff', 'admin')
  async get(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    const r = await this.reservationsService.getReservation(id);

    if (user.role === 'admin') return r;
    if (user.role === 'client') {
      if (r.user_id !== user.id) throw new ForbiddenException('Forbidden');
      return r;
    }

    const venueId = user.venue_id ?? undefined;
    if (!venueId)
      throw new ForbiddenException('Missing venue_id for this user');
    if (r.event?.venue_id !== venueId)
      throw new ForbiddenException('Forbidden');
    return r;
  }

  @Post()
  @Roles('client', 'venue', 'admin')
  async create(@Body() body: any, @CurrentUser() user: RequestUser) {
    if (user.role === 'client') {
      // Clients can only create reservations for themselves, and can never assert their
      // own price: total_amount/totalAmount is always server-computed from the zone for
      // this role (venue/admin are still allowed to pass it explicitly, e.g. for a
      // manually-priced walk-in booking).
      const { total_amount, totalAmount, ...rest } = body ?? {};
      void total_amount;
      void totalAmount;
      return this.reservationsService.createReservation({
        ...rest,
        user_id: user.id,
      });
    }

    if (user.role === 'admin') {
      return this.reservationsService.createReservation(body);
    }

    // Venue: enforce event belongs to their venue.
    const eventId = body?.event_id ?? body?.eventId;
    if (!eventId) throw new BadRequestException('event_id required');

    const venueId = user.venue_id ?? undefined;
    if (!venueId)
      throw new ForbiddenException('Missing venue_id for this user');
    await this.reservationsService.assertEventBelongsToVenue(
      String(eventId),
      venueId,
    );

    return this.reservationsService.createReservation({
      ...(body ?? {}),
      user_id: user.id,
    });
  }

  @Post('scan-entry-qr')
  @Roles('staff', 'venue', 'admin')
  async scanEntryQr(@Body() body: any, @CurrentUser() user: RequestUser) {
    const eventId = body?.event_id ?? body?.eventId;
    const qrData = body?.qr_data ?? body?.qrData ?? body?.data;
    const adminStaffId = body?.staff_id;

    try {
      if (!eventId) throw new BadRequestException('event_id required');
      if (!qrData) throw new BadRequestException('qr_data required');

      const staffId =
        user.role === 'admin' &&
        typeof adminStaffId === 'string' &&
        adminStaffId
          ? adminStaffId
          : user.id;

      if (user.role !== 'admin') {
        const venueId = user.venue_id ?? undefined;
        if (!venueId)
          throw new ForbiddenException('Missing venue_id for this user');
        await this.reservationsService.assertEventBelongsToVenue(
          eventId,
          venueId,
        );
      }

      return this.reservationsService.checkInEntryReservationByQr({
        eventId,
        staffId,
        qrData,
      });
    } catch (error: any) {
      console.error('[reservations.controller] scanEntryQr error', {
        userId: user?.id ?? null,
        role: user?.role ?? null,
        venueId: user?.venue_id ?? null,
        eventId: eventId ?? null,
        staffIdProvided: adminStaffId ?? null,
        qrPreview: String(qrData ?? '').slice(0, 40),
        errorName: error?.name,
        errorMessage: error?.message,
        statusCode: error?.status ?? error?.statusCode ?? null,
      });
      throw error;
    }
  }

  @Patch(':id')
  @Roles('venue', 'admin')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: RequestUser,
  ) {
    const r = await this.reservationsService.getReservation(id);

    if (user.role !== 'admin') {
      const venueId = user.venue_id ?? undefined;
      if (!venueId)
        throw new ForbiddenException('Missing venue_id for this user');
      if (r.event?.venue_id !== venueId)
        throw new ForbiddenException('Forbidden');
    }

    // Allow only safe fields to be updated via API.
    const updates: any = {};
    const status = this.parseOptionalStatus(body?.status);
    if (status !== undefined) updates.status = status;

    const guests = this.parseOptionalGuests(
      body?.guests ?? body?.guests_count ?? body?.guestsCount,
    );
    if (guests !== undefined) updates.guests = guests;

    const tableName = this.parseOptionalTableName(
      body?.table_name ?? body?.tableName,
    );
    if (tableName !== undefined) updates.table_name = tableName;

    const totalAmount = this.parseOptionalTotalAmount(
      body?.total_amount ?? body?.totalAmount,
    );
    if (totalAmount !== undefined) updates.total_amount = totalAmount;

    if (
      r.type !== 'table' &&
      (guests !== undefined ||
        tableName !== undefined ||
        totalAmount !== undefined)
    ) {
      throw new BadRequestException(
        'Only table reservations can update guests/table fields',
      );
    }

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('No updatable fields provided');
    }

    return this.reservationsService.updateReservation(id, updates);
  }

  @Post(':id/cancel')
  @Roles('client', 'venue', 'admin')
  async cancel(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    const r = await this.reservationsService.getReservation(id);

    if (user.role === 'client') {
      if (r.user_id !== user.id) throw new ForbiddenException('Forbidden');
      if (r.type === 'entry') {
        throw new BadRequestException(
          'Gli ingressi non sono annullabili dal cliente',
        );
      }
    } else if (user.role !== 'admin') {
      const venueId = user.venue_id ?? undefined;
      if (!venueId)
        throw new ForbiddenException('Missing venue_id for this user');
      if (r.event?.venue_id !== venueId)
        throw new ForbiddenException('Forbidden');
    }

    return this.reservationsService.cancelReservation(id);
  }

  @Post(':id/checkin')
  @Roles('staff', 'venue', 'admin')
  async checkin(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: RequestUser,
  ) {
    const r = await this.reservationsService.getReservation(id);

    if (user.role !== 'admin') {
      const venueId = user.venue_id ?? undefined;
      if (!venueId)
        throw new ForbiddenException('Missing venue_id for this user');
      if (r.event?.venue_id !== venueId)
        throw new ForbiddenException('Forbidden');
    }

    const actualGuests = body?.actual_guests ?? body?.actualGuests;
    return this.reservationsService.checkinTableReservation(
      id,
      user.id,
      actualGuests,
    );
  }

  @Post(':id/table-invitations/respond')
  @Roles('client')
  respondToTableInvitation(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: RequestUser,
  ) {
    const response = String(body?.response ?? '')
      .trim()
      .toLowerCase();
    if (response !== 'accepted' && response !== 'declined') {
      throw new BadRequestException('response must be accepted|declined');
    }

    return this.reservationsService.respondToTableInvitation({
      reservationId: id,
      userId: user.id,
      response,
    });
  }
}
