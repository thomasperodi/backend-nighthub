import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';

@Injectable()
export class FriendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
  ) {}
  private readonly logger = new Logger(FriendsService.name);
  private readonly pushDebug = process.env.PUSH_DEBUG === '1';

  private maskToken(token: string) {
    if (!token) return 'empty';
    if (token.length <= 14) return token;
    return `${token.slice(0, 10)}...${token.slice(-4)}`;
  }

  private async sendExpoPush(params: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }) {
    const token = String(params.token || '').trim();
    const isExpoToken = /^Expo(?:nent)?PushToken\[[^\]]+\]$/.test(token);
    if (!isExpoToken) {
      this.logger.warn(
        `Push skipped: invalid Expo token format (${this.maskToken(token)})`,
      );
      return;
    }

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: token,
          title: params.title,
          body: params.body,
          sound: 'default',
          priority: 'high',
          content_available: true,
          data: params.data ?? {},
        }),
      });

      let payload: any = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        this.logger.error(
          `Expo push HTTP ${response.status} for ${this.maskToken(token)}: ${JSON.stringify(payload)}`,
        );
        return;
      }

      const ticketStatus = payload?.data?.status;
      if (ticketStatus && ticketStatus !== 'ok') {
        this.logger.error(
          `Expo push rejected for ${this.maskToken(token)}: ${JSON.stringify(payload?.data)}`,
        );
        return;
      }

      if (this.pushDebug) {
        this.logger.log(
          `Expo push sent (${this.maskToken(token)}) type=${String(params.data?.type ?? 'unknown')}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Expo push exception for ${this.maskToken(token)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async notifyUsersAddedToGroup(params: {
    ownerId: string;
    groupId: string;
    groupName: string;
    memberIds: string[];
  }) {
    const uniqueMemberIds = Array.from(
      new Set((params.memberIds ?? []).filter((id) => id && id !== params.ownerId)),
    );
    if (uniqueMemberIds.length === 0) return;

    const [owner, recipients] = await Promise.all([
      this.prisma.users.findUnique({
        where: { id: params.ownerId },
        select: { name: true, username: true },
      }),
      this.prisma.users.findMany({
        where: {
          id: { in: uniqueMemberIds },
          push_token: { not: null },
        },
        select: { id: true, push_token: true },
      }),
    ]);

    if (recipients.length === 0) return;

    const ownerDisplayName = owner?.name || owner?.username || 'Un tuo amico';

    await Promise.allSettled(
      recipients
        .map((recipient) => ({ id: recipient.id, token: recipient.push_token }))
        .filter((recipient): recipient is { id: string; token: string } => Boolean(recipient.token))
        .map((recipient) =>
          this.sendExpoPush({
            token: recipient.token,
            title: 'Nuovo gruppo amici',
            body: `${ownerDisplayName} ti ha aggiunto al gruppo "${params.groupName}".`,
            data: {
              type: 'friend_group_added',
              group_id: params.groupId,
              added_by_user_id: params.ownerId,
            },
          }),
        ),
    );
  }

  async searchUsers(query: string, currentUserId: string) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];

    return this.prisma.users.findMany({
      where: {
        id: { not: currentUserId },
        OR: [
          { username: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: {
        id: true,
        username: true,
        name: true,
        avatar: true,
      },
      take: 20,
    });
  }

  async listFriends(userId: string) {
    const links = await this.prisma.friendships.findMany({
      where: { user_id: userId },
      select: { friend_id: true },
    });
    const friendIds = links.map((l) => l.friend_id);
    if (friendIds.length === 0) return [];

    return this.prisma.users.findMany({
      where: { id: { in: friendIds } },
      select: {
        id: true,
        username: true,
        name: true,
        avatar: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async listRequests(userId: string) {
    const [incoming, outgoing] = await this.prisma.$transaction([
      this.prisma.friend_requests.findMany({
        where: { to_user_id: userId, status: 'pending' },
        orderBy: { created_at: 'desc' },
        include: {
          from_user: { select: { id: true, username: true, name: true, avatar: true } },
        },
      }),
      this.prisma.friend_requests.findMany({
        where: { from_user_id: userId, status: 'pending' },
        orderBy: { created_at: 'desc' },
        include: {
          to_user: { select: { id: true, username: true, name: true, avatar: true } },
        },
      }),
    ]);

    return { incoming, outgoing };
  }

  async sendRequest(params: { from_user_id: string; username?: string; user_id?: string }) {
    const { from_user_id, username, user_id } = params;

    let target = null as { id: string } | null;
    if (user_id) {
      target = await this.prisma.users.findUnique({ where: { id: user_id }, select: { id: true } });
    } else if (username) {
      target = await this.prisma.users.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
        select: { id: true },
      });
    }

    if (!target) throw new NotFoundException('User not found');
    if (target.id === from_user_id) throw new BadRequestException('Cannot add yourself');

    const existingFriend = await this.prisma.friendships.findFirst({
      where: { user_id: from_user_id, friend_id: target.id },
      select: { id: true },
    });
    if (existingFriend) return { alreadyFriends: true };

    const existingRequest = await this.prisma.friend_requests.findFirst({
      where: {
        from_user_id,
        to_user_id: target.id,
      },
      select: { id: true, status: true },
    });
    if (existingRequest?.status === 'pending') return { alreadyRequested: true };
    if (existingRequest?.status === 'accepted') return { alreadyFriends: true };

    let createdRequest: { id: string };

    if (existingRequest?.status === 'rejected') {
      createdRequest = await this.prisma.friend_requests.update({
        where: { id: existingRequest.id },
        data: { status: 'pending' },
        select: { id: true },
      });
    } else {
      try {
        createdRequest = await this.prisma.friend_requests.create({
          data: {
            from_user_id,
            to_user_id: target.id,
            status: 'pending',
          },
          select: { id: true },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const conflicted = await this.prisma.friend_requests.findFirst({
            where: {
              from_user_id,
              to_user_id: target.id,
            },
            select: { id: true, status: true },
          });

          if (!conflicted) throw error;
          if (conflicted.status === 'pending') return { alreadyRequested: true };
          if (conflicted.status === 'accepted') return { alreadyFriends: true };

          createdRequest = await this.prisma.friend_requests.update({
            where: { id: conflicted.id },
            data: { status: 'pending' },
            select: { id: true },
          });
        } else {
          throw error;
        }
      }
    }

    const [fromUser, toUser] = await Promise.all([
      this.prisma.users.findUnique({
        where: { id: from_user_id },
        select: { name: true, username: true },
      }),
      this.prisma.users.findUnique({
        where: { id: target.id },
        select: { push_token: true },
      }),
    ]);

    if (toUser?.push_token) {
      const senderDisplayName =
        fromUser?.name || fromUser?.username || 'Un utente';
      await this.sendExpoPush({
        token: toUser.push_token,
        title: 'Nuova richiesta di amicizia',
        body: `${senderDisplayName} ti ha inviato una richiesta di amicizia.`,
        data: {
          type: 'friend_request_received',
          request_id: createdRequest.id,
          from_user_id,
        },
      });
    }

    return createdRequest;
  }

  async acceptRequest(requestId: string, userId: string) {
    const request = await this.prisma.friend_requests.findUnique({
      where: { id: requestId },
    });
    if (!request || request.to_user_id !== userId) {
      throw new NotFoundException('Request not found');
    }

    if (request.status !== 'pending') return request;

    await this.prisma.$transaction([
      this.prisma.friend_requests.update({
        where: { id: requestId },
        data: { status: 'accepted' },
      }),
      this.prisma.friendships.create({
        data: { user_id: request.from_user_id, friend_id: request.to_user_id },
      }),
      this.prisma.friendships.create({
        data: { user_id: request.to_user_id, friend_id: request.from_user_id },
      }),
    ]);

    const [acceptingUser, requesterUser] = await Promise.all([
      this.prisma.users.findUnique({
        where: { id: request.to_user_id },
        select: { name: true, username: true },
      }),
      this.prisma.users.findUnique({
        where: { id: request.from_user_id },
        select: { push_token: true },
      }),
    ]);

    if (requesterUser?.push_token) {
      const accepterDisplayName =
        acceptingUser?.name || acceptingUser?.username || 'Un utente';
      await this.sendExpoPush({
        token: requesterUser.push_token,
        title: 'Richiesta accettata',
        body: `${accepterDisplayName} ha accettato la tua richiesta di amicizia.`,
        data: {
          type: 'friend_request_accepted',
          request_id: requestId,
          from_user_id: request.to_user_id,
        },
      });
    }

    return { success: true };
  }

  async rejectRequest(requestId: string, userId: string) {
    const request = await this.prisma.friend_requests.findUnique({
      where: { id: requestId },
    });
    if (!request || request.to_user_id !== userId) {
      throw new NotFoundException('Request not found');
    }

    await this.prisma.friend_requests.update({
      where: { id: requestId },
      data: { status: 'rejected' },
    });

    return { success: true };
  }

  async removeFriend(userId: string, friendId: string) {
    await this.prisma.$transaction([
      this.prisma.friendships.deleteMany({
        where: { user_id: userId, friend_id: friendId },
      }),
      this.prisma.friendships.deleteMany({
        where: { user_id: friendId, friend_id: userId },
      }),
    ]);

    return { success: true };
  }

  async listGroups(userId: string) {
    return this.prisma.friend_groups.findMany({
      where: {
        OR: [
          { owner_id: userId },
          { members: { some: { user_id: userId } } },
        ],
      },
      orderBy: { created_at: 'desc' },
      include: {
        members: {
          include: {
            user: { select: { id: true, username: true, name: true, avatar: true } },
          },
        },
      },
    });
  }

  async createGroup(params: { owner_id: string; name: string; member_ids?: string[] }) {
    const name = String(params.name || '').trim();
    if (!name) throw new BadRequestException('name required');

    const memberIds = Array.from(
      new Set((params.member_ids ?? []).filter((id) => id && id !== params.owner_id)),
    );

    const existingMembers = memberIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: memberIds } },
          select: { id: true },
        })
      : [];

    const existingMemberIds = new Set(existingMembers.map((user) => user.id));
    const missingMemberIds = memberIds.filter((id) => !existingMemberIds.has(id));
    if (missingMemberIds.length > 0) {
      throw new BadRequestException({
        message: 'Some member_ids are invalid',
        invalid_member_ids: missingMemberIds,
      });
    }

    const group = await this.prisma.friend_groups.create({
      data: {
        name,
        owner_id: params.owner_id,
        members: {
          create: memberIds.map((id) => ({ user_id: id })),
        },
      },
      include: {
        members: {
          include: {
            user: { select: { id: true, username: true, name: true, avatar: true } },
          },
        },
      },
    });

    await this.notifyUsersAddedToGroup({
      ownerId: params.owner_id,
      groupId: group.id,
      groupName: group.name,
      memberIds,
    });

    return group;
  }

  async updateGroup(params: { group_id: string; owner_id: string; name?: string }) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: params.group_id },
    });
    if (!group || group.owner_id !== params.owner_id) {
      throw new NotFoundException('Group not found');
    }

    const name = params.name ? String(params.name).trim() : undefined;

    return this.prisma.friend_groups.update({
      where: { id: params.group_id },
      data: { name: name || undefined },
    });
  }

  async deleteGroup(params: { group_id: string; owner_id: string }) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: params.group_id },
    });
    if (!group || group.owner_id !== params.owner_id) {
      throw new NotFoundException('Group not found');
    }

    await this.prisma.friend_groups.delete({ where: { id: params.group_id } });
    return { success: true };
  }

  async addGroupMember(params: { group_id: string; owner_id: string; user_id: string }) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: params.group_id },
    });
    if (!group || group.owner_id !== params.owner_id) {
      throw new NotFoundException('Group not found');
    }

    const memberUser = await this.prisma.users.findUnique({
      where: { id: params.user_id },
      select: { id: true },
    });
    if (!memberUser) {
      throw new NotFoundException('User not found');
    }

    const existingMembership = await this.prisma.friend_group_members.findFirst({
      where: { group_id: params.group_id, user_id: params.user_id },
    });
    if (existingMembership) {
      return existingMembership;
    }

    const member = await this.prisma.friend_group_members.create({
      data: {
        group_id: params.group_id,
        user_id: params.user_id,
      },
    });

    await this.notifyUsersAddedToGroup({
      ownerId: params.owner_id,
      groupId: group.id,
      groupName: group.name,
      memberIds: [params.user_id],
    });

    return member;
  }

  async removeGroupMember(params: { group_id: string; owner_id: string; user_id: string }) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: params.group_id },
    });
    if (!group || group.owner_id !== params.owner_id) {
      throw new NotFoundException('Group not found');
    }

    await this.prisma.friend_group_members.deleteMany({
      where: { group_id: params.group_id, user_id: params.user_id },
    });
    return { success: true };
  }

  private async getGroupWithAccess(groupId: string, userId: string) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: groupId },
      include: {
        members: {
          select: {
            user_id: true,
            user: {
              select: { id: true, username: true, name: true, avatar: true },
            },
          },
        },
      },
    });

    if (!group) throw new NotFoundException('Group not found');

    const isOwner = group.owner_id === userId;
    const isMember = group.members.some((member) => member.user_id === userId);
    if (!isOwner && !isMember) throw new ForbiddenException('Forbidden');

    return { group, isOwner, isMember };
  }

  private toProposalStatus(votes: Array<{ vote: 'yes' | 'no' | 'pending' }>): 'voting' | 'ready' {
    const pending = votes.some((vote) => vote.vote === 'pending');
    const yesCount = votes.filter((vote) => vote.vote === 'yes').length;
    if (!pending && yesCount > 0) return 'ready';
    return 'voting';
  }

  private formatProposal(proposal: any) {
    const yes = proposal.votes.filter((vote: any) => vote.vote === 'yes').length;
    const no = proposal.votes.filter((vote: any) => vote.vote === 'no').length;
    const pending = proposal.votes.filter((vote: any) => vote.vote === 'pending').length;

    return {
      id: proposal.id,
      group_id: proposal.group_id,
      status: proposal.status,
      guests: proposal.guests,
      note: proposal.note,
      created_at: proposal.created_at,
      updated_at: proposal.updated_at,
      created_by_user: proposal.created_by_user,
      event: proposal.event,
      venue: proposal.venue,
      booked_reservation: proposal.booked_reservation,
      votes: proposal.votes,
      vote_stats: { yes, no, pending },
    };
  }

  private async resolveBookableEventForVenue(venueId: string) {
    const live = await this.prisma.events.findFirst({
      where: { venue_id: venueId, status: 'LIVE' },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
      select: { id: true, venue_id: true, name: true, date: true, status: true },
    });
    if (live) return live;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const next = await this.prisma.events.findFirst({
      where: {
        venue_id: venueId,
        status: { in: ['DRAFT', 'LIVE'] },
        date: { gte: today },
      },
      orderBy: [{ date: 'asc' }, { start_time: 'asc' }, { created_at: 'asc' }],
      select: { id: true, venue_id: true, name: true, date: true, status: true },
    });

    if (next) return next;

    throw new BadRequestException('Nessun evento prenotabile trovato per questo locale');
  }

  async listGroupTableProposals(groupId: string, userId: string) {
    await this.getGroupWithAccess(groupId, userId);

    const prismaAny = this.prisma as any;
    const proposals = await prismaAny.group_table_proposals.findMany({
      where: { group_id: groupId },
      orderBy: { created_at: 'desc' },
      include: {
        created_by_user: { select: { id: true, username: true, name: true, avatar: true } },
        event: { select: { id: true, name: true, date: true, start_time: true, end_time: true, status: true } },
        venue: { select: { id: true, name: true, city: true } },
        booked_reservation: { select: { id: true, status: true, guests: true, created_at: true } },
        votes: {
          orderBy: { created_at: 'asc' },
          include: { user: { select: { id: true, username: true, name: true, avatar: true } } },
        },
      },
    });

    return proposals.map((proposal) => this.formatProposal(proposal));
  }

  async createGroupTableProposal(params: {
    group_id: string;
    user_id: string;
    venue_id: string;
    guests: number;
    note?: string;
  }) {
    const guests = Number(params.guests);
    if (!Number.isInteger(guests) || guests < 2) {
      throw new BadRequestException('guests must be an integer >= 2');
    }

    const { group } = await this.getGroupWithAccess(params.group_id, params.user_id);
    const venue = await this.prisma.venues.findUnique({
      where: { id: params.venue_id },
      select: { id: true, name: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    const event = await this.resolveBookableEventForVenue(params.venue_id);
    const voterIds = Array.from(new Set([group.owner_id, ...group.members.map((member) => member.user_id)]));

    const proposal = await this.prisma.$transaction(async (tx) => {
      const created = await (tx as any).group_table_proposals.create({
        data: {
          group_id: params.group_id,
          created_by_user_id: params.user_id,
          event_id: event.id,
          venue_id: venue.id,
          guests,
          note: params.note?.trim() || null,
          status: 'voting',
        },
      });

      await (tx as any).group_table_proposal_votes.createMany({
        data: voterIds.map((voterId) => ({
          proposal_id: created.id,
          user_id: voterId,
          vote: voterId === params.user_id ? 'yes' : 'pending',
        })),
      });

      const createdWithVotes = await (tx as any).group_table_proposals.findUnique({
        where: { id: created.id },
        include: {
          created_by_user: { select: { id: true, username: true, name: true, avatar: true } },
          event: { select: { id: true, name: true, date: true, start_time: true, end_time: true, status: true } },
          venue: { select: { id: true, name: true, city: true } },
          booked_reservation: { select: { id: true, status: true, guests: true, created_at: true } },
          votes: {
            orderBy: { created_at: 'asc' },
            include: { user: { select: { id: true, username: true, name: true, avatar: true } } },
          },
        },
      });

      if (!createdWithVotes) throw new NotFoundException('Proposal not found');
      return createdWithVotes;
    });

    return this.formatProposal(proposal);
  }

  async voteGroupTableProposal(params: {
    group_id: string;
    proposal_id: string;
    user_id: string;
    vote: 'yes' | 'no' | 'pending';
  }) {
    if (!['yes', 'no', 'pending'].includes(params.vote)) {
      throw new BadRequestException('Invalid vote');
    }

    await this.getGroupWithAccess(params.group_id, params.user_id);

    const prismaAny = this.prisma as any;
    const proposal = await prismaAny.group_table_proposals.findUnique({
      where: { id: params.proposal_id },
      include: {
        votes: true,
      },
    });
    if (!proposal || proposal.group_id !== params.group_id) {
      throw new NotFoundException('Proposal not found');
    }
    if (proposal.status === 'booked' || proposal.status === 'cancelled') {
      throw new BadRequestException('Proposal is closed');
    }

    const existingVote = proposal.votes.find((vote) => vote.user_id === params.user_id);
    if (!existingVote) throw new ForbiddenException('User cannot vote on this proposal');

    const updated = await this.prisma.$transaction(async (tx) => {
      await (tx as any).group_table_proposal_votes.update({
        where: { proposal_id_user_id: { proposal_id: params.proposal_id, user_id: params.user_id } },
        data: { vote: params.vote },
      });

      const votes = await (tx as any).group_table_proposal_votes.findMany({
        where: { proposal_id: params.proposal_id },
        select: { vote: true },
      });

      const nextStatus = this.toProposalStatus(votes);
      await (tx as any).group_table_proposals.update({
        where: { id: params.proposal_id },
        data: { status: nextStatus },
      });

      return (tx as any).group_table_proposals.findUnique({
        where: { id: params.proposal_id },
        include: {
          created_by_user: { select: { id: true, username: true, name: true, avatar: true } },
          event: { select: { id: true, name: true, date: true, start_time: true, end_time: true, status: true } },
          venue: { select: { id: true, name: true, city: true } },
          booked_reservation: { select: { id: true, status: true, guests: true, created_at: true } },
          votes: {
            orderBy: { created_at: 'asc' },
            include: { user: { select: { id: true, username: true, name: true, avatar: true } } },
          },
        },
      });
    });

    if (!updated) throw new NotFoundException('Proposal not found');
    return this.formatProposal(updated);
  }

  async bookGroupTableProposal(params: {
    group_id: string;
    proposal_id: string;
    user_id: string;
    table_name?: string;
  }) {
    const { group, isOwner } = await this.getGroupWithAccess(params.group_id, params.user_id);

    const prismaAny = this.prisma as any;
    const proposal = await prismaAny.group_table_proposals.findUnique({
      where: { id: params.proposal_id },
      include: {
        votes: true,
        event: { select: { id: true, venue_id: true } },
      },
    });

    if (!proposal || proposal.group_id !== params.group_id) {
      throw new NotFoundException('Proposal not found');
    }

    if (proposal.created_by_user_id !== params.user_id && !isOwner) {
      throw new ForbiddenException('Only proposal creator or group owner can book');
    }

    if (proposal.status === 'booked' && proposal.booked_reservation_id) {
      const existingReservation = await this.reservationsService.getReservation(proposal.booked_reservation_id);
      return { reservation: existingReservation, proposal_id: proposal.id, already_booked: true };
    }

    const yesVotes = proposal.votes.filter((vote: any) => vote.vote === 'yes').length;
    if (yesVotes < 1) {
      throw new BadRequestException('Not enough yes votes to book');
    }

    const fallbackTable = await this.prisma.venue_tables.findFirst({
      where: { venue_id: proposal.event.venue_id },
      orderBy: [{ zona: 'asc' }, { nome: 'asc' }],
      select: { id: true },
    });
    if (!fallbackTable) {
      throw new BadRequestException('Nessun tavolo/zona disponibile per il locale');
    }

    const reservation = await this.reservationsService.createReservation({
      user_id: params.user_id,
      event_id: proposal.event_id,
      type: 'table',
      guests: yesVotes,
      venue_zone_id: fallbackTable.id,
      venue_table_id: fallbackTable.id,
      status: 'pending',
      table_name: params.table_name?.trim() || `Gruppo ${group.name}`,
    });

    await prismaAny.group_table_proposals.update({
      where: { id: params.proposal_id },
      data: {
        status: 'booked',
        booked_reservation_id: reservation.id,
      },
    });

    return {
      reservation,
      proposal_id: proposal.id,
      booked_guests: yesVotes,
    };
  }

  async cancelGroupTableProposal(params: {
    group_id: string;
    proposal_id: string;
    user_id: string;
  }) {
    const { isOwner } = await this.getGroupWithAccess(params.group_id, params.user_id);

    const prismaAny = this.prisma as any;
    const proposal = await prismaAny.group_table_proposals.findUnique({
      where: { id: params.proposal_id },
      include: {
        created_by_user: { select: { id: true, username: true, name: true, avatar: true } },
        event: { select: { id: true, name: true, date: true, start_time: true, end_time: true, status: true } },
        venue: { select: { id: true, name: true, city: true } },
        booked_reservation: { select: { id: true, status: true, guests: true, created_at: true } },
        votes: {
          orderBy: { created_at: 'asc' },
          include: { user: { select: { id: true, username: true, name: true, avatar: true } } },
        },
      },
    });

    if (!proposal || proposal.group_id !== params.group_id) {
      throw new NotFoundException('Proposal not found');
    }

    if (proposal.created_by_user_id !== params.user_id && !isOwner) {
      throw new ForbiddenException('Only proposal creator or group owner can cancel');
    }

    if (proposal.status === 'booked') {
      throw new BadRequestException('Booked proposal cannot be cancelled');
    }

    if (proposal.status === 'cancelled') {
      return this.formatProposal(proposal);
    }

    const updated = await prismaAny.group_table_proposals.update({
      where: { id: params.proposal_id },
      data: { status: 'cancelled' },
      include: {
        created_by_user: { select: { id: true, username: true, name: true, avatar: true } },
        event: { select: { id: true, name: true, date: true, start_time: true, end_time: true, status: true } },
        venue: { select: { id: true, name: true, city: true } },
        booked_reservation: { select: { id: true, status: true, guests: true, created_at: true } },
        votes: {
          orderBy: { created_at: 'asc' },
          include: { user: { select: { id: true, username: true, name: true, avatar: true } } },
        },
      },
    });

    return this.formatProposal(updated);
  }
}
