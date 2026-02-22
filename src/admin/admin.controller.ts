import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import { AdminService } from './admin.service';
import { CreateAdminVenueDto } from './dto/create-admin-venue.dto';
import { UpdateVenueContractDto } from './dto/update-venue-contract.dto';
import { UpdateUserAssignmentDto } from './dto/update-user-assignment.dto';

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

  @Patch('users/:id/assignment')
  updateUserAssignment(
    @Param('id') userId: string,
    @Body() body: UpdateUserAssignmentDto,
  ) {
    return this.adminService.updateUserAssignment(userId, body);
  }

  @Get('reports')
  reports() {
    return this.adminService.getReports();
  }

  @Get('profile')
  profile(@CurrentUser() user: RequestUser) {
    return this.adminService.getProfile(user.id);
  }
}
