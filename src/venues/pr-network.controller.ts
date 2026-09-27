import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import { PrNetworkService } from './pr-network.service';
import {
  AddMyTeamMemberDto,
  UpdateMyTeamMemberDto,
} from './dto/my-pr-team.dto';

/**
 * The PR's own endpoints that aren't tied to one venue in the URL: an organization PR works
 * every venue of its organization. A PR logs in with the `client` JWT role (PR-ness is a
 * membership overlay), so authorization is done in PrNetworkService against the caller's
 * active memberships, never by role alone.
 */
@Controller('pr-network')
export class PrNetworkController {
  constructor(private readonly prNetwork: PrNetworkService) {}

  @Get('me/events')
  @Roles('client', 'staff', 'venue', 'admin')
  listMyEvents(
    @Query('past') past: string | undefined,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.prNetwork.listMyEvents(user, {
      past: past === 'true' || past === '1',
    });
  }

  @Get('me/team')
  @Roles('client', 'staff', 'venue', 'admin')
  listMyTeam(
    @Query('membership_id') membershipId: string | undefined,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.prNetwork.listMyTeam(user, membershipId || undefined);
  }

  @Get('me/team/lookup')
  @Roles('client', 'staff', 'venue', 'admin')
  lookupForMyTeam(
    @Query('identifier') identifier: string,
    @Query('membership_id') membershipId: string | undefined,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.prNetwork.lookupForMyTeam(
      user,
      identifier,
      membershipId || undefined,
    );
  }

  @Post('me/team')
  @Roles('client', 'staff', 'venue', 'admin')
  addToMyTeam(
    @Body() body: AddMyTeamMemberDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.prNetwork.addToMyTeam(user, body);
  }

  @Patch('me/team/:memberId')
  @Roles('client', 'staff', 'venue', 'admin')
  updateMyTeamMember(
    @Param('memberId') memberId: string,
    @Body() body: UpdateMyTeamMemberDto,
    @CurrentUser() user?: RequestUser,
  ) {
    return this.prNetwork.updateMyTeamMember(user, memberId, body);
  }
}
