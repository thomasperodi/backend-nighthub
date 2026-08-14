import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { BadgesService } from './badges.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller('badges')
export class BadgesController {
  constructor(private readonly badgesService: BadgesService) {}

  /** Full static catalog (name, description, icon, rarity, category) - no unlock status. */
  @Get('catalog')
  @Roles('client')
  catalog() {
    return this.badgesService.getStaticCatalog();
  }

  /** Own or a friend's badge collection, with progress shown only for yourself. */
  @Get('user/:userId')
  @Roles('client')
  forUser(@Param('userId') userId: string, @CurrentUser() user: RequestUser) {
    const targetUserId = userId === 'me' ? user.id : userId;
    return this.badgesService.getBadgesForViewer(user.id, targetUserId);
  }

  @Get('me')
  @Roles('client')
  mine(@CurrentUser() user: RequestUser) {
    return this.badgesService.getUnlockedForUser(user.id);
  }

  @Get('level')
  @Roles('client')
  level(@CurrentUser() user: RequestUser) {
    return this.badgesService.getNightLevel(user.id);
  }

  @Post('sync')
  @Roles('client')
  sync(@CurrentUser() user: RequestUser) {
    return this.badgesService.evaluateForUser(user.id);
  }

  @Post(':userBadgeId/seen')
  @Roles('client')
  markSeen(
    @Param('userBadgeId') userBadgeId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.badgesService.markSeen(user.id, userBadgeId);
  }

  /** Admin-only manual award, for badges whose criteria.type is 'manual' (e.g. the_connector,
   * bottle_service) - these can never be earned automatically via evaluateForUser. */
  @Post('admin/award')
  @Roles('admin')
  async adminAward(@Body() body: { user_id?: string; badge_code?: string }) {
    const userId = String(body?.user_id || '').trim();
    const badgeCode = String(body?.badge_code || '').trim();
    if (!userId || !badgeCode) {
      throw new BadRequestException('user_id and badge_code are required');
    }

    const result = await this.badgesService.awardManualBadge(
      userId,
      badgeCode,
    );
    if (!result) throw new BadRequestException('Unknown badge_code');
    return result;
  }
}
