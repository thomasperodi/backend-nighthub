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
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { LinkVenueDto } from './dto/link-venue.dto';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  @Roles('admin')
  create(
    @Body() dto: CreateOrganizationDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.organizationsService.create(dto, user);
  }

  @Get()
  @Roles('admin')
  list(@CurrentUser() user?: RequestUser) {
    return this.organizationsService.list(user);
  }

  @Get('me')
  @Roles('client', 'staff', 'venue', 'admin', 'organization')
  getMine(@CurrentUser() user?: RequestUser) {
    return this.organizationsService.getMine(user);
  }

  @Get(':id')
  @Roles('admin', 'organization')
  getById(@Param('id') id: string, @CurrentUser() user?: RequestUser) {
    return this.organizationsService.getById(id, user);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOrganizationDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.organizationsService.update(id, dto, user);
  }

  @Post(':id/venue-links')
  @Roles('admin')
  linkVenue(
    @Param('id') id: string,
    @Body() dto: LinkVenueDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.organizationsService.linkVenue(id, dto.venue_id, user);
  }

  @Delete(':id/venue-links/:venueId')
  @Roles('admin')
  unlinkVenue(
    @Param('id') id: string,
    @Param('venueId') venueId: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.organizationsService.unlinkVenue(id, venueId, user);
  }

  @Get(':id/venues')
  @Roles('admin', 'organization')
  listVenues(@Param('id') id: string, @CurrentUser() user?: RequestUser) {
    return this.organizationsService.listVenues(id, user);
  }

  @Get(':id/pr-network')
  @Roles('admin', 'organization')
  listPrNetwork(@Param('id') id: string, @CurrentUser() user?: RequestUser) {
    return this.organizationsService.listPrNetwork(id, user);
  }

  @Get(':id/stats')
  @Roles('admin', 'organization')
  getStats(
    @Param('id') id: string,
    @Query('venue_id') venueId?: string,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.organizationsService.getStats(id, user, venueId);
  }
}
