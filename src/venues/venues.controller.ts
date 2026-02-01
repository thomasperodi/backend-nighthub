import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Res,
  ForbiddenException,
} from '@nestjs/common';
import type { Response } from 'express';
import { VenuesService } from './venues.service';
import { EventsService } from '../events/events.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { CreateVenueTablesBulkDto } from './dto/create-venue-tables-bulk.dto';
import { UpdateVenueTableDto } from './dto/update-venue-table.dto';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller('venues')
export class VenuesController {
  constructor(
    private readonly venuesService: VenuesService,
    private readonly eventsService: EventsService,
  ) {}

  @Get()
  @Public()
  list(@Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    );
    return this.venuesService.listVenues();
  }

  @Get(':id')
  @Public()
  get(@Param('id') id: string, @Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    );
    return this.venuesService.getVenue(id);
  }

  @Post()
  @Roles('admin')
  create(@Body() body: CreateVenueDto) {
    return this.venuesService.createVenue(body);
  }

  @Patch(':id')
  @Roles('admin')
  update(@Param('id') id: string, @Body() body: UpdateVenueDto) {
    return this.venuesService.updateVenue(id, body);
  }

  @Delete(':id')
  @Roles('admin')
  delete(@Param('id') id: string) {
    return this.venuesService.deleteVenue(id);
  }

  @Get(':id/events')
  @Public()
  events(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('date') date?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=30, stale-while-revalidate=300',
    );
    return this.eventsService.listEvents({ venue_id: id, status, date });
  }

  @Get(':id/stats')
  @Roles('venue', 'admin')
  stats(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=10, stale-while-revalidate=60',
    );

    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.getStats(id);
  }

  @Get(':id/promos')
  @Public()
  promos(@Param('id') id: string, @Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=30, stale-while-revalidate=300',
    );
    return this.venuesService.listPromos(id);
  }

  // Venue structural tables (persisted in DB)
  @Get(':id/tables')
  @Public()
  tables(@Param('id') id: string, @Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    );
    return this.venuesService.listVenueTables(id);
  }

  @Post(':id/tables')
  @Roles('venue', 'admin')
  createTables(
    @Param('id') id: string,
    @Body() body: CreateVenueTablesBulkDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.createVenueTablesBulk(id, body);
  }

  @Delete(':id/tables/:tableId')
  @Roles('venue', 'admin')
  deleteTable(
    @Param('id') id: string,
    @Param('tableId') tableId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.deleteVenueTable(id, tableId);
  }

  @Patch(':id/tables/:tableId')
  @Roles('venue', 'admin')
  updateTable(
    @Param('id') id: string,
    @Param('tableId') tableId: string,
    @Body() body: UpdateVenueTableDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.updateVenueTable(id, tableId, body);
  }
}
