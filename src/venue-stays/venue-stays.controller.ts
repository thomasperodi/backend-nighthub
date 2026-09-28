import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  Body,
} from '@nestjs/common';
import { VenueStaysService } from './venue-stays.service';
import { VenueStayCheckpointDto } from './dto/venue-stay-checkpoint.dto';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller('venue-stays')
export class VenueStaysController {
  constructor(private readonly venueStaysService: VenueStaysService) {}

  @Post('checkpoint')
  @Roles('client')
  checkpoint(
    @Body() body: VenueStayCheckpointDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.venueStaysService.checkpoint({
      user_id: user.id,
      venue_id: body.venue_id,
      event_id: body.event_id,
      event_type: body.event_type,
      timestamp: body.timestamp,
      exit_source: body.exit_source,
    });
  }

  /** The caller's stay still open (with the venue position), or null. */
  @Get('current')
  @Roles('client')
  current(@CurrentUser() user: RequestUser) {
    return this.venueStaysService.currentStay(user.id);
  }

  @Get()
  @Roles('client', 'venue', 'admin')
  async list(
    @CurrentUser() user: RequestUser,
    @Query('user_id') userId?: string,
    @Query('venue_id') venueId?: string,
    @Query('event_id') eventId?: string,
    @Query('limit') limit?: string,
  ) {
    const take = limit ? parseInt(limit, 10) : undefined;

    if (user.role === 'client') {
      return this.venueStaysService.list({ user_id: user.id, limit: take });
    }

    if (user.role === 'venue') {
      const scopedVenueId = user.venue_id ?? undefined;
      if (!scopedVenueId)
        throw new BadRequestException('Missing venue_id for this user');
      // Anonymous for the venue: times and durations for its analytics, never who (see the
      // privacy page). No filtering by user either, for the same reason.
      void userId;
      const rows = await this.venueStaysService.list({
        venue_id: scopedVenueId,
        event_id: eventId,
        limit: take,
      });
      return rows.map(({ user_id, ...rest }) => {
        void user_id;
        return rest;
      });
    }

    return this.venueStaysService.list({
      venue_id: venueId,
      event_id: eventId,
      user_id: userId,
      limit: take,
    });
  }
}
