import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get()
  @Roles('client', 'venue', 'admin')
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
        return this.reservationsService.listReservationsPaginated(pageNum, pageSizeNum, {
          eventId,
          userId: user.id,
        });
      }
      return this.reservationsService.listReservations({ eventId, userId: user.id });
    }

    // Admin can query with explicit filters (keeps existing behavior for ops).
    if (user.role === 'admin') {
      if (page || pageSize) {
        const pageNum = page ? parseInt(page, 10) || 1 : 1;
        const pageSizeNum = pageSize ? parseInt(pageSize, 10) || 20 : 20;
        return this.reservationsService.listReservationsPaginated(pageNum, pageSizeNum, {
          eventId,
          userId,
        });
      }
      return this.reservationsService.listReservations({ eventId, userId });
    }

    // Venue: must be scoped to their venue AND to the requested event.
    if (!eventId) throw new BadRequestException('event_id required');

    const venueId = user.venue_id ?? undefined;
    if (!venueId) throw new ForbiddenException('Missing venue_id for this user');
    return (async () => {
      await this.reservationsService.assertEventBelongsToVenue(eventId, venueId);

      if (page || pageSize) {
        const pageNum = page ? parseInt(page, 10) || 1 : 1;
        const pageSizeNum = pageSize ? parseInt(pageSize, 10) || 20 : 20;
        return this.reservationsService.listReservationsPaginated(pageNum, pageSizeNum, {
          eventId,
          venueId,
        });
      }

      return this.reservationsService.listReservations({ eventId, venueId });
    })();
  }

  // Public/low-sensitivity endpoint for client-side availability checks.
  // Returns only booked table ids for a given event.
  @Get('booked-tables')
  @Public()
  bookedTables(
    @Query('event_id') eventIdSnake?: string,
    @Query('eventId') eventIdCamel?: string,
  ) {
    const eventId = eventIdSnake ?? eventIdCamel;
    if (!eventId) throw new BadRequestException('event_id required');
    return this.reservationsService.listBookedTableIdsForEvent(eventId);
  }

  @Get(':id')
  @Roles('client', 'venue', 'admin')
  async get(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    const r = await this.reservationsService.getReservation(id);

    if (user.role === 'admin') return r;
    if (user.role === 'client') {
      if (r.user_id !== user.id) throw new ForbiddenException('Forbidden');
      return r;
    }

    const venueId = user.venue_id ?? undefined;
    if (!venueId) throw new ForbiddenException('Missing venue_id for this user');
    if (r.event?.venue_id !== venueId) throw new ForbiddenException('Forbidden');
    return r;
  }

  @Post()
  @Roles('client', 'venue', 'admin')
  async create(@Body() body: any, @CurrentUser() user: RequestUser) {
    if (user.role === 'client') {
      // Clients can only create reservations for themselves.
      return this.reservationsService.createReservation({
        ...(body ?? {}),
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
    if (!venueId) throw new ForbiddenException('Missing venue_id for this user');
    await this.reservationsService.assertEventBelongsToVenue(String(eventId), venueId);

    return this.reservationsService.createReservation(body);
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
      if (!venueId) throw new ForbiddenException('Missing venue_id for this user');
      if (r.event?.venue_id !== venueId) throw new ForbiddenException('Forbidden');
    }

    // Allow only safe fields to be updated via API.
    const updates: any = {};
    if (body && typeof body === 'object' && 'status' in body) updates.status = body.status;
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
    } else if (user.role !== 'admin') {
      const venueId = user.venue_id ?? undefined;
      if (!venueId) throw new ForbiddenException('Missing venue_id for this user');
      if (r.event?.venue_id !== venueId) throw new ForbiddenException('Forbidden');
    }

    return this.reservationsService.cancelReservation(id);
  }
}
