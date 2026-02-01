import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  ForbiddenException,
} from '@nestjs/common';
import { PromosService } from './promos.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller('promos')
@Roles('venue', 'admin')
export class PromosController {
  constructor(private readonly promosService: PromosService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    void page;
    void pageSize;

    if (user.role === 'admin') return this.promosService.listPromos();
    if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
    return this.promosService.listByVenue(user.venue_id);
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    const promo = await this.promosService.getPromo(id);
    if (user.role === 'admin') return promo;
    if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
    if (promo.venue_id !== user.venue_id) throw new ForbiddenException('Forbidden');
    return promo;
  }

  @Get('/by-event/:eventId')
  byEvent(@Param('eventId') eventId: string, @CurrentUser() user: RequestUser) {
    if (user.role === 'admin') return this.promosService.listByEvent(eventId);
    if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
    return this.promosService.listByEventForVenue(eventId, user.venue_id);
  }

  @Get('/by-venue/:venueId')
  byVenue(
    @Param('venueId') venueId: string,
    @CurrentUser() user: RequestUser,
  ) {
    if (user.role === 'admin') return this.promosService.listByVenue(venueId);
    if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
    if (venueId !== user.venue_id) throw new ForbiddenException('Forbidden');
    return this.promosService.listByVenue(user.venue_id);
  }

  @Post()
  async create(@Body() body: any, @CurrentUser() user: RequestUser) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      body = { ...(body ?? {}), venue_id: user.venue_id };
      const eventId = body?.event_id ?? body?.eventId;
      if (eventId) {
        await this.promosService.assertEventBelongsToVenue(String(eventId), user.venue_id);
      }
    }
    return this.promosService.createPromo(body);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() user: RequestUser,
  ) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      const existing = await this.promosService.getPromo(id);
      if (existing.venue_id !== user.venue_id) throw new ForbiddenException('Forbidden');

      const eventId = body?.event_id ?? body?.eventId;
      if (eventId) {
        await this.promosService.assertEventBelongsToVenue(String(eventId), user.venue_id);
      }

      // prevent cross-venue reassignment
      if (body && typeof body === 'object') {
        delete body.venue_id;
        delete body.venueId;
      }
    }

    return this.promosService.updatePromo(id, body);
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      const existing = await this.promosService.getPromo(id);
      if (existing.venue_id !== user.venue_id) throw new ForbiddenException('Forbidden');
    }
    return this.promosService.deletePromo(id);
  }
}
