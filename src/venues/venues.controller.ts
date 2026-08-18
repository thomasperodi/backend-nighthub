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
  Headers,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { VenuesService } from './venues.service';
import { EventsService } from '../events/events.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { RequireVenueOwnership } from '../common/guards/venue-ownership.guard';
import { CreateVenueDto } from './dto/create-venue.dto';
import { CreateVenueStationsBulkDto } from './dto/create-venue-stations-bulk.dto';
import { UpdateVenueImageDto } from './dto/update-venue-image.dto';
import { UpdateVenueWalletTemplateDto } from './dto/update-venue-wallet-template.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { UpdateVenuePricingDto } from './dto/update-venue-pricing.dto';
import { CreateVenueTablesBulkDto } from './dto/create-venue-tables-bulk.dto';
import { UpdateVenueStationDto } from './dto/update-venue-station.dto';
import { UpdateVenueTableDto } from './dto/update-venue-table.dto';
import { CreateVenueTableZoneDto } from './dto/create-venue-table-zone.dto';
import { UpdateVenueTableZoneDto } from './dto/update-venue-table-zone.dto';
import { UpdateVenueFloorPlanDto } from './dto/update-venue-floor-plan.dto';
import { CreateVenueFloorLandmarkDto } from './dto/create-venue-floor-landmark.dto';
import { UpdateVenueFloorLandmarkDto } from './dto/update-venue-floor-landmark.dto';
import { CreateZoneTablesDto } from './dto/create-zone-tables.dto';
import { CreateVenuePrMemberDto } from './dto/create-venue-pr-member.dto';
import { UpdateVenuePrMemberDto } from './dto/update-venue-pr-member.dto';
import { AssignPrEventDto } from './dto/assign-pr-event.dto';
import { RegisterPrScanDto } from './dto/register-pr-scan.dto';
import { RegisterPrEntryDto } from './dto/register-pr-entry.dto';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller('venues')
export class VenuesController {
  constructor(
    private readonly venuesService: VenuesService,
    private readonly eventsService: EventsService,
    private readonly organizationsService: OrganizationsService,
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

  @Get('pr-network/me')
  @Roles('client', 'staff', 'venue', 'admin')
  listMyPrMemberships(@CurrentUser() user?: RequestUser) {
    return this.venuesService.listMyPrVenueMemberships(user);
  }

  @Get('passes/apple/:passId')
  @Public()
  async downloadPrApplePass(
    @Param('passId') passId: string,
    @Query('token') token: string | undefined,
    @Res() res: Response,
  ) {
    const payload = await this.venuesService.getPrSeasonPassApplePkpass(
      passId,
      token,
    );

    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${payload.filename}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(payload.buffer);
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

  @Patch(':id/image')
  @Roles('venue', 'admin')
  updateImage(
    @Param('id') id: string,
    @Body() body: UpdateVenueImageDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }

    return this.venuesService.updateVenueImage(id, body?.image);
  }

  @Post(':id/image')
  @Roles('venue', 'admin')
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(
    @Param('id') id: string,
    @UploadedFile()
    file?: { buffer: Buffer; mimetype: string; originalname: string },
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }

    return this.venuesService.uploadVenueImage(file);
  }

  // Fase 7 "tessere custom": per-venue PR season pass branding. Uses RequireVenueOwnership
  // (the new reusable guard) rather than the inline if/throw the endpoints above still use -
  // new code should prefer it over copying that pattern further.
  @Get(':id/wallet-template')
  @Roles('venue', 'admin')
  @RequireVenueOwnership()
  getWalletTemplate(@Param('id') id: string) {
    return this.venuesService.getVenueWalletTemplate(id);
  }

  @Patch(':id/wallet-template')
  @Roles('venue', 'admin')
  @RequireVenueOwnership()
  updateWalletTemplate(
    @Param('id') id: string,
    @Body() body: UpdateVenueWalletTemplateDto,
  ) {
    return this.venuesService.updateVenueWalletTemplate(id, body);
  }

  @Post(':id/wallet-template/logo')
  @Roles('venue', 'admin')
  @RequireVenueOwnership()
  @UseInterceptors(FileInterceptor('file'))
  async uploadWalletLogo(
    @Param('id') id: string,
    @UploadedFile()
    file?: { buffer: Buffer; mimetype: string; originalname: string },
  ) {
    const { path } = await this.venuesService.uploadVenueWalletLogo(file);
    return this.venuesService.setVenueWalletLogo(id, path);
  }

  @Delete(':id/wallet-template/logo')
  @Roles('venue', 'admin')
  @RequireVenueOwnership()
  deleteWalletLogo(@Param('id') id: string) {
    return this.venuesService.setVenueWalletLogo(id, null);
  }

  @Post(':id/image/signed')
  @Roles('venue', 'admin')
  createImageSignedUpload(
    @Param('id') id: string,
    @Headers('authorization') authorization?: string,
    @Body() body?: { ext?: string; contentType?: string },
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }

    void authorization;
    return this.venuesService.createVenueImageSignedUpload(body);
  }

  @Get(':id/pricing')
  @Roles('staff', 'venue', 'admin')
  getPricing(@Param('id') id: string, @CurrentUser() user?: RequestUser) {
    if (String(user?.role || '').toLowerCase() !== 'admin') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }

    return this.venuesService.getVenuePricing(id);
  }

  @Patch(':id/pricing')
  @Roles('venue', 'admin')
  updatePricing(
    @Param('id') id: string,
    @Body() body: UpdateVenuePricingDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }

    return this.venuesService.updateVenuePricing(id, body);
  }

  @Get(':id/users')
  @Roles('client', 'staff', 'venue', 'admin')
  listUsersForPrNetwork(
    @Param('id') id: string,
    @Query('search') search: string | undefined,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.listAssignableUsersForPr(id, search, user);
  }

  @Get(':id/pr-network/me')
  @Roles('client', 'staff', 'venue', 'admin')
  getMyPrNetworkMembership(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.getMyPrNetworkMembership(id, user);
  }

  @Get(':id/pr-network/me/season-pass')
  @Roles('client', 'staff', 'venue', 'admin')
  getMyPrSeasonPass(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.getMyPrSeasonPass(id, user);
  }

  @Post(':id/pr-network/me/season-pass/refresh-wallet')
  @Roles('client', 'staff', 'venue', 'admin')
  refreshMyPrSeasonPassWalletLinks(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.getMyPrSeasonPass(id, user, {
      refreshWalletLinks: true,
    });
  }

  // Resolves an existing user by id/email/username so the venue team-management screen can
  // invite someone without asking for a raw UUID - CreateVenuePrMemberDto only accepts
  // `user_id`, and unlike admin's resolveUserByIdentifier, nothing venue-scoped existed to
  // look one up before creating the membership.
  @Get(':id/pr-network/lookup')
  @Roles('venue', 'admin', 'organization')
  async lookupPrNetworkUser(
    @Param('id') id: string,
    @Query('identifier') identifier: string,
    @CurrentUser() user?: RequestUser,
  ) {
    const role = String(user?.role || '').toLowerCase();
    if (role === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    } else if (role === 'organization') {
      // An organization invites PRs at any of its own linked venues (see
      // OrganizationPrScreen) - not just a venue it owns directly, so the check is against
      // the org<->venue link rather than a single venue_id match.
      if (!user?.organization_id) {
        throw new ForbiddenException('Missing organization_id');
      }
      await this.venuesService.assertOrganizationLinkedToVenue(
        user.organization_id,
        id,
      );
    }
    return this.venuesService.lookupUserForPrInvite(identifier);
  }

  @Get(':id/pr-network')
  @Roles('client', 'staff', 'venue', 'admin')
  listPrNetworkMembers(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.listVenuePrNetworkMembers(id, user);
  }

  // Organizations linked to this venue - feeds both the venue-side "which organizations
  // work here" view and the org picker in the PR-network invite form (see
  // CreateVenuePrMemberDto.organization_id).
  @Get(':id/organizations')
  @Roles('venue', 'admin')
  @RequireVenueOwnership()
  listVenueOrganizations(@Param('id') id: string) {
    return this.organizationsService.listForVenue(id);
  }

  // Performance of one linked organization's PRs, scoped to this venue's own events only -
  // see OrganizationsService.getStatsForVenue's doc comment for why the scoping is
  // structural (entries/scans carry venue_id) rather than an extra filter.
  @Get(':id/organizations/:orgId/stats')
  @Roles('venue', 'admin')
  @RequireVenueOwnership()
  getVenueOrganizationStats(
    @Param('id') id: string,
    @Param('orgId') orgId: string,
  ) {
    return this.organizationsService.getStatsForVenue(id, orgId);
  }

  @Post(':id/pr-network')
  @Roles('client', 'staff', 'venue', 'admin')
  createPrNetworkMember(
    @Param('id') id: string,
    @Body() body: CreateVenuePrMemberDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.createVenuePrNetworkMember(id, body, user);
  }

  @Patch(':id/pr-network/:memberId')
  @Roles('client', 'staff', 'venue', 'admin')
  updatePrNetworkMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() body: UpdateVenuePrMemberDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.updateVenuePrNetworkMember(
      id,
      memberId,
      body,
      user,
    );
  }

  @Delete(':id/pr-network/:memberId')
  @Roles('client', 'staff', 'venue', 'admin')
  deletePrNetworkMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.deleteVenuePrNetworkMember(id, memberId, user);
  }

  @Post(':id/pr-events/assignments')
  @Roles('client', 'staff', 'venue', 'admin')
  assignPrToEvent(
    @Param('id') id: string,
    @Body() body: AssignPrEventDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.assignPrMemberToEvent(id, body, user);
  }

  @Get(':id/pr-events/:eventId/assignments')
  @Roles('client', 'staff', 'venue', 'admin')
  listPrEventAssignments(
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.listPrEventAssignments(id, eventId, user);
  }

  @Post(':id/pr-scans')
  @Roles('client', 'staff', 'venue', 'admin')
  registerPrQrScan(
    @Param('id') id: string,
    @Body() body: RegisterPrScanDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.registerPrQrScan(id, body, user);
  }

  @Post(':id/pr-scans/:scanId/entry')
  @Roles('client', 'staff', 'venue', 'admin')
  registerPrEntry(
    @Param('id') id: string,
    @Param('scanId') scanId: string,
    @Body() body: RegisterPrEntryDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.registerPrEntryFromScan(id, scanId, body, user);
  }

  @Get(':id/pr-dashboard')
  @Roles('client', 'staff', 'venue', 'admin')
  getPrDashboard(
    @Param('id') id: string,
    @Query('eventId') eventId: string | undefined,
    @Query('membershipId') membershipId: string | undefined,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.getPrDashboardStats(id, user, {
      event_id: eventId,
      membership_id: membershipId,
    });
  }

  @Delete(':id')
  @Roles('admin')
  delete(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.venuesService.deleteVenue(id, user.id);
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
      if (!user?.venue_id || user.venue_id !== id)
        throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.getStats(id);
  }

  @Get(':id/analytics')
  @Roles('venue', 'admin')
  analytics(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=10, stale-while-revalidate=60',
    );

    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }

    return this.venuesService.getAnalytics(id);
  }

  @Get(':id/analytics/overview')
  @Roles('venue', 'admin')
  analyticsOverview(
    @Param('id') id: string,
    @Query('eventId') eventId?: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.getAnalyticsOverview(id, eventId);
  }

  @Get(':id/analytics/demographics')
  @Roles('venue', 'admin')
  analyticsDemographics(
    @Param('id') id: string,
    @Query('eventId') eventId?: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.getAnalyticsDemographics(id, eventId);
  }

  @Get(':id/analytics/revenue-breakdown')
  @Roles('venue', 'admin')
  analyticsRevenueBreakdown(
    @Param('id') id: string,
    @Query('eventId') eventId?: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.getRevenueBreakdown(id, eventId);
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

  @Get(':id/table-zones')
  @Public()
  tableZones(
    @Param('id') id: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=120, stale-while-revalidate=900',
    );
    return this.venuesService.listVenueTableZones(id);
  }

  @Post(':id/table-zones')
  @Roles('venue', 'admin')
  createTableZone(
    @Param('id') id: string,
    @Body() body: CreateVenueTableZoneDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.createVenueTableZone(id, body);
  }

  @Patch(':id/table-zones/:zoneId')
  @Roles('venue', 'admin')
  updateTableZone(
    @Param('id') id: string,
    @Param('zoneId') zoneId: string,
    @Body() body: UpdateVenueTableZoneDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.updateVenueTableZone(id, zoneId, body);
  }

  @Delete(':id/table-zones/:zoneId')
  @Roles('venue', 'admin')
  deleteTableZone(
    @Param('id') id: string,
    @Param('zoneId') zoneId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.deleteVenueTableZone(id, zoneId);
  }

  @Get(':id/floor-plan')
  @Public()
  floorPlan(
    @Param('id') id: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=90, stale-while-revalidate=600',
    );
    return this.venuesService.getVenueFloorPlan(id);
  }

  @Patch(':id/floor-plan')
  @Roles('venue', 'admin')
  updateFloorPlan(
    @Param('id') id: string,
    @Body() body: UpdateVenueFloorPlanDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.updateVenueFloorPlan(id, body);
  }

  @Post(':id/floor-plan/landmarks')
  @Roles('venue', 'admin')
  createFloorPlanLandmark(
    @Param('id') id: string,
    @Body() body: CreateVenueFloorLandmarkDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.createVenueFloorLandmark(id, body);
  }

  @Patch(':id/floor-plan/landmarks/:landmarkId')
  @Roles('venue', 'admin')
  updateFloorPlanLandmark(
    @Param('id') id: string,
    @Param('landmarkId') landmarkId: string,
    @Body() body: UpdateVenueFloorLandmarkDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.updateVenueFloorLandmark(id, landmarkId, body);
  }

  @Delete(':id/floor-plan/landmarks/:landmarkId')
  @Roles('venue', 'admin')
  deleteFloorPlanLandmark(
    @Param('id') id: string,
    @Param('landmarkId') landmarkId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.deleteVenueFloorLandmark(id, landmarkId);
  }

  @Post(':id/table-zones/:zoneId/tables')
  @Roles('venue', 'admin')
  createTablesFromZone(
    @Param('id') id: string,
    @Param('zoneId') zoneId: string,
    @Body() body: CreateZoneTablesDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.createZoneTables(id, zoneId, body);
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

  @Get(':id/stations')
  @Roles('staff', 'venue', 'admin')
  stations(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=120, stale-while-revalidate=600',
    );
    if (String(user?.role || '').toLowerCase() !== 'admin') {
      if (!user?.venue_id || user.venue_id !== id) {
        throw new ForbiddenException('Forbidden');
      }
    }
    return this.venuesService.listVenueStations(id);
  }

  @Post(':id/stations')
  @Roles('venue', 'admin')
  createStations(
    @Param('id') id: string,
    @Body() body: CreateVenueStationsBulkDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id)
        throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.createVenueStationsBulk(id, body);
  }

  @Patch(':id/stations/:stationId')
  @Roles('venue', 'admin')
  updateStation(
    @Param('id') id: string,
    @Param('stationId') stationId: string,
    @Body() body: UpdateVenueStationDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id)
        throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.updateVenueStation(id, stationId, body);
  }

  @Delete(':id/stations/:stationId')
  @Roles('venue', 'admin')
  deleteStation(
    @Param('id') id: string,
    @Param('stationId') stationId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id)
        throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.deleteVenueStation(id, stationId);
  }

  @Post(':id/tables')
  @Roles('venue', 'admin')
  createTables(
    @Param('id') id: string,
    @Body() body: CreateVenueTablesBulkDto,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id)
        throw new ForbiddenException('Forbidden');
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
      if (!user?.venue_id || user.venue_id !== id)
        throw new ForbiddenException('Forbidden');
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
      if (!user?.venue_id || user.venue_id !== id)
        throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.updateVenueTable(id, tableId, body);
  }
}
