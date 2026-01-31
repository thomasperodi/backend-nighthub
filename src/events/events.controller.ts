import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

@Controller()
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get('events')
  async list(
    @Query('venue_id') venue_id?: string,
    @Query('status') status?: string,
    @Query('date') date?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    // Enable Vercel edge caching (keyed by full URL incl. querystring).
    // Keep TTL short to avoid stale event lists while still removing repeated load.
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=30, stale-while-revalidate=300',
    );

    if (page || pageSize) {
      const pageNum = page ? parseInt(page, 10) || 1 : 1;
      const pageSizeNum = pageSize ? parseInt(pageSize, 10) || 10 : 10;
      return this.eventsService.listEventsPaginated(pageNum, pageSizeNum, {
        venue_id,
        status,
        date,
      });
    }

    return this.eventsService.listEvents({ venue_id, status, date });
  }

  @Get('events/:id')
  getOne(@Param('id') id: string, @Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    );
    return this.eventsService.getEvent(id);
  }

  @Get('events/:id/stats')
  getStats(@Param('id') id: string) {
    return this.eventsService.getEventStats(id);
  }

  @Post('events')
  create(@Body() dto: CreateEventDto) {
    return this.eventsService.createEvent(dto);
  }

  @Patch('events/:id')
  update(@Param('id') id: string, @Body() dto: UpdateEventDto) {
    return this.eventsService.updateEvent(id, dto);
  }

  @Delete('events/:id')
  remove(@Param('id') id: string) {
    return this.eventsService.deleteEvent(id);
  }
}
