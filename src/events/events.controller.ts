import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtService } from '@nestjs/jwt';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';

@Controller()
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly jwtService: JwtService,
  ) {}

  private assertStaffAuth(authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, '') || undefined;
    if (!token) throw new UnauthorizedException('Missing Authorization token');

    let payload: { role?: string };
    try {
      payload = this.jwtService.verify<{ role?: string }>(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

    const role = String(payload?.role || '').toLowerCase();
    if (!role || role === 'client') {
      throw new ForbiddenException('Insufficient permissions');
    }
  }

  private assertCronAuth(params: {
    token?: string;
    headerSecret?: string;
    authorization?: string;
  }) {
    // Prefer staff auth if provided
    if (params.authorization) {
      this.assertStaffAuth(params.authorization);
      return;
    }

    const expected = process.env.CRON_SECRET || '';
    if (!expected) {
      throw new ForbiddenException('CRON_SECRET is not configured');
    }

    const provided = params.headerSecret || params.token || '';
    if (!provided || provided !== expected) {
      throw new ForbiddenException('Invalid cron secret');
    }
  }

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

  // Upload poster separately to keep event create/update fast.
  // Client sends multipart/form-data with field name `file`.
  @Post('events/poster')
  @UseInterceptors(FileInterceptor('file'))
  uploadPoster(@UploadedFile() file?: Express.Multer.File) {
    return this.eventsService.uploadEventPoster(file);
  }

  // Preferred: client-direct upload (no bytes through Vercel).
  // Returns { bucket, path, token, signedUrl } for Supabase Storage.
  @Post('events/poster/signed')
  createPosterSignedUpload(
    @Headers('authorization') authorization?: string,
    @Body() body?: { ext?: string; contentType?: string },
  ) {
    this.assertStaffAuth(authorization);
    return this.eventsService.createEventPosterSignedUpload(body);
  }

  @Patch('events/:id')
  update(@Param('id') id: string, @Body() dto: UpdateEventDto) {
    return this.eventsService.updateEvent(id, dto);
  }

  @Delete('events/:id')
  remove(@Param('id') id: string) {
    return this.eventsService.deleteEvent(id);
  }

  // Used by Vercel Cron (or other scheduler) to keep DB status up-to-date even with no client traffic.
  @Get('events/sync-status')
  syncStatus(
    @Query('token') token?: string,
    @Headers('x-cron-secret') headerSecret?: string,
    @Headers('authorization') authorization?: string,
  ) {
    this.assertCronAuth({ token, headerSecret, authorization });
    return this.eventsService.syncEventStatusesNow({
      daysBack: 2,
      daysForward: 2,
    });
  }
}
