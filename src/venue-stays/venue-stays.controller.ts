import { BadRequestException, Controller, Get, Post, Query, Body } from '@nestjs/common';
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
  checkpoint(@Body() body: VenueStayCheckpointDto, @CurrentUser() user: RequestUser) {
    return this.venueStaysService.checkpoint({
      user_id: user.id,
      venue_id: body.venue_id,
      event_type: body.event_type,
      timestamp: body.timestamp,
    });
  }

  @Get()
  @Roles('client', 'venue', 'admin')
  list(
    @CurrentUser() user: RequestUser,
    @Query('user_id') userId?: string,
    @Query('venue_id') venueId?: string,
    @Query('limit') limit?: string,
  ) {
    const take = limit ? parseInt(limit, 10) : undefined;

    if (user.role === 'client') {
      return this.venueStaysService.list({ user_id: user.id, limit: take });
    }

    if (user.role === 'venue') {
      const scopedVenueId = user.venue_id ?? undefined;
      if (!scopedVenueId) throw new BadRequestException('Missing venue_id for this user');
      return this.venueStaysService.list({
        venue_id: scopedVenueId,
        user_id: userId,
        limit: take,
      });
    }

    return this.venueStaysService.list({
      venue_id: venueId,
      user_id: userId,
      limit: take,
    });
  }
}
