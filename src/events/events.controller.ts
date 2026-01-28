import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
  ) {
    // Debug: understand why LIVE events might not be returned
    // (safe log: no PII, only filters + server time)
    console.log('[events.controller] GET /events', {
      venue_id,
      status,
      date,
      page,
      pageSize,
      serverNow: new Date().toISOString(),
    });

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
  getOne(@Param('id') id: string) {
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
