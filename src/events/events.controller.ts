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
import { AuthService } from '../auth/auth.service';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

type UploadedPosterFile = {
  originalname?: string;
  mimetype?: string;
  buffer: Buffer;
};

@Controller()
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly authService: AuthService,
  ) {}

  // Reuses AuthService.verifyAccessToken (the same verification JwtAuthGuard uses for every
  // other request) instead of re-implementing JWT verification here - this endpoint is
  // @Public() (see syncStatus below) specifically so it can also be called by a scheduler
  // with a shared secret, which is why it can't just rely on the global guard.
  private assertStaffAuth(authorization?: string) {
    const token = authorization?.replace(/^Bearer\s+/i, '') || undefined;
    if (!token) throw new UnauthorizedException('Missing Authorization token');

    const user = this.authService.verifyAccessToken(token);
    if (!user.role || user.role === 'client') {
      throw new ForbiddenException('Insufficient permissions');
    }
  }

  private assertCronAuth(params: {
    token?: string;
    headerSecret?: string;
    authorization?: string;
  }) {
    // Vercel Cron Jobs automatically send `Authorization: Bearer <CRON_SECRET>` on every
    // invocation - check that match first (cheap, no crypto) before falling back to
    // treating `authorization` as a staff JWT, which is how this endpoint can also be
    // triggered manually by staff.
    const expected = process.env.CRON_SECRET || '';
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(params.authorization || '');
    const providedSecret =
      params.headerSecret || bearerMatch?.[1] || params.token || '';
    if (expected && providedSecret === expected) return;

    if (params.authorization) {
      this.assertStaffAuth(params.authorization);
      return;
    }

    if (!expected) {
      throw new ForbiddenException('CRON_SECRET is not configured');
    }
    throw new ForbiddenException('Invalid cron secret');
  }

  @Get('events')
  @Public()
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

  // Used by Vercel Cron (or other scheduler) to keep DB status up-to-date even with no
  // client traffic. Must be registered before `events/:id` below - Nest/Express match
  // routes in registration order, and `:id` would otherwise swallow this literal path
  // (a request to /events/sync-status would be treated as getOne(id="sync-status") and
  // fail with a Prisma "invalid UUID" error instead of ever reaching this handler).
  @Get('events/sync-status')
  @Public()
  async syncStatus(
    @Query('token') token?: string,
    @Headers('x-cron-secret') headerSecret?: string,
    @Headers('authorization') authorization?: string,
  ) {
    this.assertCronAuth({ token, headerSecret, authorization });
    const [statusResult, autoFeaturedResult] = await Promise.all([
      this.eventsService.syncEventStatusesNow({
        daysBack: 2,
        daysForward: 2,
      }),
      this.eventsService.evaluateAutoFeaturedEvents(),
    ]);

    return {
      success: statusResult.success && autoFeaturedResult.success,
      statusUpdated: statusResult.updated,
      autoFeaturedUpdated: autoFeaturedResult.updated,
    };
  }

  @Get('events/:id')
  @Public()
  getOne(@Param('id') id: string, @Res({ passthrough: true }) res?: Response) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    );
    return this.eventsService.getEvent(id);
  }

  @Get('events/:id/friends-going')
  @Roles('client')
  getFriendsGoing(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.eventsService.getFriendsGoing(id, user.id);
  }

  @Get('events/:id/stats')
  @Roles('venue', 'admin')
  async getStats(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      await this.eventsService.assertEventBelongsToVenue(id, user.venue_id);
    }
    return this.eventsService.getEventStats(id);
  }

  @Post('events')
  @Roles('venue', 'admin')
  create(@Body() dto: CreateEventDto, @CurrentUser() user: RequestUser) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      dto.venue_id = user.venue_id;
      // Paid featured placement is admin-granted, not something a venue can set on its own
      // event - see the doc comment on `is_featured` in schema.prisma.
      dto.is_featured = false;
    }
    return this.eventsService.createEvent(dto);
  }

  // Upload poster separately to keep event create/update fast.
  // Client sends multipart/form-data with field name `file`.
  @Post('events/poster')
  @Roles('venue', 'admin')
  @UseInterceptors(FileInterceptor('file'))
  uploadPoster(@UploadedFile() file?: UploadedPosterFile) {
    return this.eventsService.uploadEventPoster(file);
  }

  // Preferred: client-direct upload (no bytes through Vercel).
  // Returns { bucket, path, token, signedUrl } for Supabase Storage.
  @Post('events/poster/signed')
  @Roles('venue', 'admin')
  createPosterSignedUpload(
    @Headers('authorization') authorization?: string,
    @Body() body?: { ext?: string; contentType?: string },
  ) {
    // Guarded by roles; keep header param only for backward compatibility.
    void authorization;
    return this.eventsService.createEventPosterSignedUpload(body);
  }

  @Patch('events/:id')
  @Roles('venue', 'admin')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
    @CurrentUser() user: RequestUser,
  ) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      await this.eventsService.assertEventBelongsToVenue(id, user.venue_id);
      dto.venue_id = user.venue_id;
      // Same reasoning as create(): a venue can't grant itself is_featured - leaving the
      // field undefined (not false) means EventsService.updateEvent leaves whatever value
      // is already there untouched, instead of silently un-featuring an admin/auto grant.
      delete dto.is_featured;
    }
    return this.eventsService.updateEvent(id, dto);
  }

  @Post('events/:id/cancel')
  @Roles('venue', 'admin')
  async cancel(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      await this.eventsService.assertEventBelongsToVenue(id, user.venue_id);
    }
    return this.eventsService.cancelEvent(id);
  }

  @Delete('events/:id')
  @Roles('venue', 'admin')
  async remove(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      await this.eventsService.assertEventBelongsToVenue(id, user.venue_id);
    }
    return this.eventsService.deleteEvent(id);
  }
}
