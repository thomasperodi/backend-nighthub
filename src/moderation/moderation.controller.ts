import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller()
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  // Any authenticated user can report another user's profile - no @Roles restriction, same
  // as other self-service endpoints (e.g. push-token).
  @Post('reports')
  fileReport(
    @Body() body: { reported_user_id?: string; reason?: string },
    @CurrentUser() user: RequestUser,
  ) {
    return this.moderationService.fileReport({
      reporterId: user.id,
      reportedUserId: String(body?.reported_user_id || ''),
      reason: String(body?.reason || ''),
    });
  }

  // Blocks: self-service for any authenticated user, like reports. Only the blocker ever
  // sees the list; the blocked user is never told.
  @Get('blocks')
  listBlocks(@CurrentUser() user: RequestUser) {
    return this.moderationService.listBlocks(user.id);
  }

  @Post('blocks')
  block(@Body() body: { user_id?: string }, @CurrentUser() user: RequestUser) {
    return this.moderationService.blockUser(
      user.id,
      String(body?.user_id || ''),
    );
  }

  @Delete('blocks/:userId')
  unblock(@Param('userId') userId: string, @CurrentUser() user: RequestUser) {
    return this.moderationService.unblockUser(user.id, userId);
  }

  // Named content-reports (not `admin/reports`) - that path is already taken by
  // AdminService.getReports(), an unrelated operational-issues summary.
  @Get('admin/content-reports')
  @Roles('admin')
  listReports(@Query('status') status?: string) {
    return this.moderationService.listReports(status);
  }

  @Patch('admin/content-reports/:id')
  @Roles('admin')
  resolveReport(
    @Param('id') reportId: string,
    @Body()
    body: {
      status?: 'resolved' | 'dismissed';
      resolution_note?: string;
      suspend_reported_user?: boolean;
      remove_avatar?: boolean;
    },
    @CurrentUser() user: RequestUser,
  ) {
    if (body?.status !== 'resolved' && body?.status !== 'dismissed') {
      throw new BadRequestException('status must be "resolved" or "dismissed"');
    }
    return this.moderationService.resolveReport({
      reportId,
      adminId: user.id,
      status: body.status,
      resolutionNote: body.resolution_note,
      suspendReportedUser: Boolean(body.suspend_reported_user),
      removeAvatar: Boolean(body.remove_avatar),
    });
  }
}
