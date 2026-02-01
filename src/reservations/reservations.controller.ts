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
  UnauthorizedException,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { JwtService } from '@nestjs/jwt';

@Controller('reservations')
export class ReservationsController {
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly jwtService: JwtService,
  ) {}

  private parseAuth(authorization?: string): {
    userId: string;
    role: string;
    venueId?: string | null;
  } {
    const token = authorization?.replace(/^Bearer\s+/i, '') || undefined;
    if (!token) throw new UnauthorizedException('Missing Authorization token');

    let payload: unknown;
    try {
      payload = this.jwtService.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    if (!payload || typeof payload !== 'object' || !('sub' in payload)) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const p = payload as { sub?: string; role?: string; venue_id?: string | null; venueId?: string | null };
    const userId = String(p.sub || '');
    const role = String(p.role || '').toLowerCase();
    const venueId = (p.venue_id ?? p.venueId ?? null) as string | null;

    if (!userId) throw new UnauthorizedException('Invalid token payload');
    if (!role) throw new UnauthorizedException('Invalid token payload');

    return { userId, role, venueId };
  }

  private async resolveVenueIdForAuth(auth: { userId: string; role: string; venueId?: string | null }) {
    if (auth.venueId) return auth.venueId;
    return this.reservationsService.resolveVenueIdForUser(auth.userId);
  }

  @Get()
  list(
    @Headers('authorization') authorization?: string,
    @Query('event_id') eventIdSnake?: string,
    @Query('eventId') eventIdCamel?: string,
    @Query('user_id') userIdSnake?: string,
    @Query('userId') userIdCamel?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const eventId = eventIdSnake ?? eventIdCamel;
    const userId = userIdSnake ?? userIdCamel;

    const auth = this.parseAuth(authorization);

    // Clients can only see their own reservations (optionally filtered by event).
    if (auth.role === 'client') {
      if (page || pageSize) {
        const pageNum = page ? parseInt(page, 10) || 1 : 1;
        const pageSizeNum = pageSize ? parseInt(pageSize, 10) || 20 : 20;
        return this.reservationsService.listReservationsPaginated(pageNum, pageSizeNum, {
          eventId,
          userId: auth.userId,
        });
      }
      return this.reservationsService.listReservations({ eventId, userId: auth.userId });
    }

    // Admin can query with explicit filters (keeps existing behavior for ops).
    if (auth.role === 'admin') {
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

    // Staff/Venue: must be scoped to their venue AND to the requested event.
    if (!eventId) throw new BadRequestException('event_id required');

    return (async () => {
      const venueId = await this.resolveVenueIdForAuth(auth);
      if (!venueId) throw new ForbiddenException('Missing venue_id for this user');
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

  @Get(':id')
  async get(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const auth = this.parseAuth(authorization);
    const r = await this.reservationsService.getReservation(id);

    if (auth.role === 'admin') return r;
    if (auth.role === 'client') {
      if (r.user_id !== auth.userId) throw new ForbiddenException('Forbidden');
      return r;
    }

    const venueId = await this.resolveVenueIdForAuth(auth);
    if (!venueId) throw new ForbiddenException('Missing venue_id for this user');
    if (r.event?.venue_id !== venueId) throw new ForbiddenException('Forbidden');
    return r;
  }

  @Post()
  async create(@Body() body: any, @Headers('authorization') authorization?: string) {
    const auth = this.parseAuth(authorization);

    if (auth.role === 'client') {
      // Clients can only create reservations for themselves.
      return this.reservationsService.createReservation({
        ...body,
        user_id: auth.userId,
      });
    }

    if (auth.role === 'admin') {
      return this.reservationsService.createReservation(body);
    }

    // Staff/Venue: enforce event belongs to their venue.
    const eventId = body?.event_id ?? body?.eventId;
    if (!eventId) throw new BadRequestException('event_id required');

    const venueId = await this.resolveVenueIdForAuth(auth);
    if (!venueId) throw new ForbiddenException('Missing venue_id for this user');
    await this.reservationsService.assertEventBelongsToVenue(String(eventId), venueId);

    return this.reservationsService.createReservation(body);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @Headers('authorization') authorization?: string,
  ) {
    const auth = this.parseAuth(authorization);
    const r = await this.reservationsService.getReservation(id);

    if (auth.role === 'client') {
      if (r.user_id !== auth.userId) throw new ForbiddenException('Forbidden');
    } else if (auth.role !== 'admin') {
      const venueId = await this.resolveVenueIdForAuth(auth);
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
  async cancel(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const auth = this.parseAuth(authorization);
    const r = await this.reservationsService.getReservation(id);

    if (auth.role === 'client') {
      if (r.user_id !== auth.userId) throw new ForbiddenException('Forbidden');
    } else if (auth.role !== 'admin') {
      const venueId = await this.resolveVenueIdForAuth(auth);
      if (!venueId) throw new ForbiddenException('Missing venue_id for this user');
      if (r.event?.venue_id !== venueId) throw new ForbiddenException('Forbidden');
    }

    return this.reservationsService.cancelReservation(id);
  }
}
