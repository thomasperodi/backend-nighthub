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
import { CreateVenueStationsBulkDto } from './dto/create-venue-stations-bulk.dto';
import { UpdateVenueDto } from './dto/update-venue.dto';
import { UpdateVenuePricingDto } from './dto/update-venue-pricing.dto';
import { CreateVenueTablesBulkDto } from './dto/create-venue-tables-bulk.dto';
import { UpdateVenueStationDto } from './dto/update-venue-station.dto';
import { UpdateVenueTableDto } from './dto/update-venue-table.dto';
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

  @Post(':id/stripe/connect/onboarding')
  @Roles('venue', 'admin')
  createStripeConnectOnboarding(
    @Param('id') id: string,
    @Body() body: { refresh_url?: string; return_url?: string; email?: string },
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) throw new ForbiddenException('Forbidden');
    }

    return this.venuesService.createStripeConnectOnboardingLink({
      venueId: id,
      refreshUrl: body?.refresh_url,
      returnUrl: body?.return_url,
      email: body?.email,
    });
  }

  @Get(':id/stripe/connect/status')
  @Roles('venue', 'admin')
  getStripeConnectStatus(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
  ) {
    if (String(user?.role || '').toLowerCase() === 'venue') {
      if (!user?.venue_id || user.venue_id !== id) throw new ForbiddenException('Forbidden');
    }
    return this.venuesService.getStripeConnectStatus(id);
  }

  @Get(':id/pricing')
  @Roles('staff', 'venue', 'admin')
  getPricing(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
  ) {
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

  @Get(':id/pr-network')
  @Roles('client', 'staff', 'venue', 'admin')
  listPrNetworkMembers(
    @Param('id') id: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.venuesService.listVenuePrNetworkMembers(id, user);
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
    return this.venuesService.updateVenuePrNetworkMember(id, memberId, body, user);
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
      if (!user?.venue_id || user.venue_id !== id) throw new ForbiddenException('Forbidden');
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
      if (!user?.venue_id || user.venue_id !== id) throw new ForbiddenException('Forbidden');
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
      if (!user?.venue_id || user.venue_id !== id) throw new ForbiddenException('Forbidden');
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
