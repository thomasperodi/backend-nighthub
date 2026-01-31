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
} from '@nestjs/common';
import type { Response } from 'express';
import { VenuesService } from './venues.service';
import { EventsService } from '../events/events.service';
import { CreateVenueDto } from './dto/create-venue.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { CreateVenueTablesBulkDto } from './dto/create-venue-tables-bulk.dto';
import { UpdateVenueTableDto } from './dto/update-venue-table.dto';

@Controller('venues')
export class VenuesController {
  constructor(
    private readonly venuesService: VenuesService,
    private readonly eventsService: EventsService,
  ) {}

  @Get()
  list(@Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    );
    return this.venuesService.listVenues();
  }

  @Get(':id')
  get(@Param('id') id: string, @Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    );
    return this.venuesService.getVenue(id);
  }

  @Post()
  create(@Body() body: CreateVenueDto) {
    return this.venuesService.createVenue(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateVenueDto) {
    return this.venuesService.updateVenue(id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.venuesService.deleteVenue(id);
  }

  @Get(':id/events')
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
  stats(@Param('id') id: string, @Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=10, stale-while-revalidate=60',
    );
    return this.venuesService.getStats(id);
  }

  @Get(':id/promos')
  promos(@Param('id') id: string, @Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=30, stale-while-revalidate=300',
    );
    return this.venuesService.listPromos(id);
  }

  // Venue structural tables (persisted in DB)
  @Get(':id/tables')
  tables(@Param('id') id: string, @Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    );
    return this.venuesService.listVenueTables(id);
  }

  @Post(':id/tables')
  createTables(
    @Param('id') id: string,
    @Body() body: CreateVenueTablesBulkDto,
  ) {
    return this.venuesService.createVenueTablesBulk(id, body);
  }

  @Delete(':id/tables/:tableId')
  deleteTable(@Param('id') id: string, @Param('tableId') tableId: string) {
    return this.venuesService.deleteVenueTable(id, tableId);
  }

  @Patch(':id/tables/:tableId')
  updateTable(
    @Param('id') id: string,
    @Param('tableId') tableId: string,
    @Body() body: UpdateVenueTableDto,
  ) {
    return this.venuesService.updateVenueTable(id, tableId, body);
  }
}
