import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { FriendsService } from './friends.service';
import { FriendRequestDto } from './dto/friend-request.dto';
import { CreateGroupDto } from './dto/create-group.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { GroupMemberDto } from './dto/group-member.dto';
import { CreateGroupTableProposalDto } from './dto/create-group-table-proposal.dto';
import { VoteGroupTableProposalDto } from './dto/vote-group-table-proposal.dto';
import { BookGroupTableProposalDto } from './dto/book-group-table-proposal.dto';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller()
export class FriendsController {
  constructor(private readonly friendsService: FriendsService) {}

  @Get('friends/search')
  @Roles('client')
  search(@Query('query') query: string, @CurrentUser() user: RequestUser) {
    return this.friendsService.searchUsers(query, user.id);
  }

  @Get('friends')
  @Roles('client')
  list(@CurrentUser() user: RequestUser) {
    return this.friendsService.listFriends(user.id);
  }

  @Get('friends/requests')
  @Roles('client')
  requests(@CurrentUser() user: RequestUser) {
    return this.friendsService.listRequests(user.id);
  }

  @Post('friends/requests')
  @Roles('client')
  request(@Body() body: FriendRequestDto, @CurrentUser() user: RequestUser) {
    if (!body?.username && !body?.user_id) {
      throw new BadRequestException('username or user_id required');
    }
    return this.friendsService.sendRequest({
      from_user_id: user.id,
      username: body.username,
      user_id: body.user_id,
    });
  }

  @Post('friends/requests/:id/accept')
  @Roles('client')
  accept(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.friendsService.acceptRequest(id, user.id);
  }

  @Post('friends/requests/:id/reject')
  @Roles('client')
  reject(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.friendsService.rejectRequest(id, user.id);
  }

  @Delete('friends/:id')
  @Roles('client')
  remove(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.friendsService.removeFriend(user.id, id);
  }

  @Get('friend-groups')
  @Roles('client')
  listGroups(@CurrentUser() user: RequestUser) {
    return this.friendsService.listGroups(user.id);
  }

  @Post('friend-groups')
  @Roles('client')
  createGroup(@Body() body: CreateGroupDto, @CurrentUser() user: RequestUser) {
    return this.friendsService.createGroup({
      owner_id: user.id,
      name: body.name,
      member_ids: body.member_ids,
    });
  }

  @Post('friend-groups/:id/members')
  @Roles('client')
  addMember(
    @Param('id') id: string,
    @Body() body: GroupMemberDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.friendsService.addGroupMember({
      group_id: id,
      owner_id: user.id,
      user_id: body.user_id,
    });
  }

  @Delete('friend-groups/:id/members/:userId')
  @Roles('client')
  removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.friendsService.removeGroupMember({
      group_id: id,
      owner_id: user.id,
      user_id: userId,
    });
  }

  @Post('friend-groups/:id')
  @Roles('client')
  updateGroup(
    @Param('id') id: string,
    @Body() body: UpdateGroupDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.friendsService.updateGroup({
      group_id: id,
      owner_id: user.id,
      name: body.name,
    });
  }

  @Delete('friend-groups/:id')
  @Roles('client')
  deleteGroup(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.friendsService.deleteGroup({ group_id: id, owner_id: user.id });
  }

  @Get('friend-groups/:id/table-proposals')
  @Roles('client')
  listGroupTableProposals(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.friendsService.listGroupTableProposals(id, user.id);
  }

  @Post('friend-groups/:id/table-proposals')
  @Roles('client')
  createGroupTableProposal(
    @Param('id') id: string,
    @Body() body: CreateGroupTableProposalDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.friendsService.createGroupTableProposal({
      group_id: id,
      user_id: user.id,
      venue_id: body.venue_id,
      guests: body.guests,
      note: body.note,
    });
  }

  @Post('friend-groups/:id/table-proposals/:proposalId/vote')
  @Roles('client')
  voteGroupTableProposal(
    @Param('id') id: string,
    @Param('proposalId') proposalId: string,
    @Body() body: VoteGroupTableProposalDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.friendsService.voteGroupTableProposal({
      group_id: id,
      proposal_id: proposalId,
      user_id: user.id,
      vote: body.vote,
    });
  }

  @Post('friend-groups/:id/table-proposals/:proposalId/book')
  @Roles('client')
  bookGroupTableProposal(
    @Param('id') id: string,
    @Param('proposalId') proposalId: string,
    @Body() body: BookGroupTableProposalDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.friendsService.bookGroupTableProposal({
      group_id: id,
      proposal_id: proposalId,
      user_id: user.id,
      table_name: body.table_name,
    });
  }

  @Post('friend-groups/:id/table-proposals/:proposalId/cancel')
  @Roles('client')
  cancelGroupTableProposal(
    @Param('id') id: string,
    @Param('proposalId') proposalId: string,
    @CurrentUser() user: RequestUser,
  ) {
    return this.friendsService.cancelGroupTableProposal({
      group_id: id,
      proposal_id: proposalId,
      user_id: user.id,
    });
  }
}
