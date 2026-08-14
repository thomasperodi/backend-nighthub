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
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import { AdminService } from './admin.service';
import { CreateAdminVenueDto } from './dto/create-admin-venue.dto';
import { UpdateVenueContractDto } from './dto/update-venue-contract.dto';
import { UpdateUserAssignmentDto } from './dto/update-user-assignment.dto';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { AssignVenuePlanDto } from './dto/assign-venue-plan.dto';

@Controller('admin')
@Roles('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('dashboard')
  dashboard() {
    return this.adminService.getDashboard();
  }

  @Get('venues')
  venues() {
    return this.adminService.getVenues();
  }

  @Get('users')
  users() {
    return this.adminService.getUsers();
  }

  // Trust & safety: search across all users (getUsers above is a 50-most-recent dashboard
  // widget, not a search) and suspend/reactivate one. :id accepts id/email/username, same
  // as PATCH users/:id/assignment.
  @Get('users/search')
  searchUsers(@Query('search') search?: string) {
    return this.adminService.searchUsers(search);
  }

  @Post('users/:id/suspend')
  suspendUser(@Param('id') userIdentifier: string, @CurrentUser() user: RequestUser) {
    return this.adminService.setUserActive(userIdentifier, false, user.id);
  }

  @Post('users/:id/reactivate')
  reactivateUser(@Param('id') userIdentifier: string, @CurrentUser() user: RequestUser) {
    return this.adminService.setUserActive(userIdentifier, true, user.id);
  }

  // "Account" = venue (see AdminService.listAccounts doc comment).
  @Get('accounts')
  accounts(@Query('search') search?: string) {
    return this.adminService.listAccounts(search);
  }

  @Post('accounts/:id/suspend')
  suspendAccount(@Param('id') venueId: string, @CurrentUser() user: RequestUser) {
    return this.adminService.setAccountActive(venueId, false, user.id);
  }

  @Post('accounts/:id/reactivate')
  reactivateAccount(@Param('id') venueId: string, @CurrentUser() user: RequestUser) {
    return this.adminService.setAccountActive(venueId, true, user.id);
  }

  @Get('audit-log')
  auditLog(
    @Query('target_type') targetType?: string,
    @Query('target_id') targetId?: string,
  ) {
    return this.adminService.listAuditLog({ targetType, targetId });
  }

  @Post('venues')
  createVenue(@Body() body: CreateAdminVenueDto) {
    return this.adminService.createVenue(body);
  }

  @Patch('venues/:id/contract')
  updateVenueContract(
    @Param('id') venueId: string,
    @Body() body: UpdateVenueContractDto,
  ) {
    return this.adminService.updateVenueContract(venueId, body);
  }

  // :id accepts a user id, email, or username (see AdminService.resolveUserByIdentifier).
  @Patch('users/:id/assignment')
  updateUserAssignment(
    @Param('id') userIdentifier: string,
    @Body() body: UpdateUserAssignmentDto,
  ) {
    return this.adminService.updateUserAssignment(userIdentifier, body);
  }

  @Get('plans')
  plans() {
    return this.adminService.listPlans();
  }

  @Post('plans')
  createPlan(@Body() body: CreatePlanDto) {
    return this.adminService.createPlan(body);
  }

  @Patch('plans/:id')
  updatePlan(@Param('id') planId: string, @Body() body: UpdatePlanDto) {
    return this.adminService.updatePlan(planId, body);
  }

  @Delete('plans/:id')
  deletePlan(@Param('id') planId: string) {
    return this.adminService.deletePlan(planId);
  }

  @Patch('venues/:id/plan')
  assignVenuePlan(
    @Param('id') venueId: string,
    @Body() body: AssignVenuePlanDto,
  ) {
    return this.adminService.assignVenuePlan(venueId, body);
  }

  @Get('reports')
  reports() {
    return this.adminService.getReports();
  }

  @Get('profile')
  profile(@CurrentUser() user: RequestUser) {
    return this.adminService.getProfile(user.id);
  }

  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.adminService.getMe(user.id);
  }
}
