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
import { AssignOrganizationPlanDto } from './dto/assign-organization-plan.dto';
import { CreateOrganizationPrMemberDto } from './dto/create-organization-pr-member.dto';
import { UpdateOrganizationPrMemberDto } from './dto/update-organization-pr-member.dto';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import { RequireOrganizationOwnership } from '../common/guards/organization-ownership.guard';

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
  @RequireOrganizationOwnership()
  getById(@Param('id') id: string) {
    return this.organizationsService.getById(id);
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

  @Patch(':id/plan')
  @Roles('admin')
  assignPlan(
    @Param('id') id: string,
    @Body() dto: AssignOrganizationPlanDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.organizationsService.assignPlan(id, dto.plan_id, user);
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
  @RequireOrganizationOwnership()
  listVenues(@Param('id') id: string) {
    return this.organizationsService.listVenues(id);
  }

  @Get(':id/pr-network')
  @Roles('admin', 'organization')
  @RequireOrganizationOwnership()
  listPrNetwork(@Param('id') id: string) {
    return this.organizationsService.listPrNetwork(id);
  }

  @Post(':id/pr-network')
  @Roles('admin', 'organization')
  @RequireOrganizationOwnership()
  createPrMember(
    @Param('id') id: string,
    @Body() dto: CreateOrganizationPrMemberDto,
  ) {
    return this.organizationsService.createPrMember(id, dto);
  }

  @Patch(':id/pr-network/:memberId')
  @Roles('admin', 'organization')
  @RequireOrganizationOwnership()
  updatePrMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateOrganizationPrMemberDto,
  ) {
    return this.organizationsService.updatePrMember(id, memberId, dto);
  }

  @Delete(':id/pr-network/:memberId')
  @Roles('admin', 'organization')
  @RequireOrganizationOwnership()
  deletePrMember(@Param('id') id: string, @Param('memberId') memberId: string) {
    return this.organizationsService.deletePrMember(id, memberId);
  }

  @Get(':id/events')
  @Roles('admin', 'organization')
  @RequireOrganizationOwnership()
  listEvents(@Param('id') id: string) {
    return this.organizationsService.listEvents(id);
  }

  @Get(':id/stats')
  @Roles('admin', 'organization')
  @RequireOrganizationOwnership()
  getStats(@Param('id') id: string, @Query('venue_id') venueId?: string) {
    return this.organizationsService.getStats(id, venueId);
  }
}
