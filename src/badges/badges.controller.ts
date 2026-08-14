import { Controller, Get, Param, Post } from '@nestjs/common';
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
}
