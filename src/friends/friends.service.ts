import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FriendsService {
  constructor(private readonly prisma: PrismaService) {}

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
        status: 'pending',
      },
      select: { id: true },
    });
    if (existingRequest) return { alreadyRequested: true };

    return this.prisma.friend_requests.create({
      data: {
        from_user_id,
        to_user_id: target.id,
        status: 'pending',
      },
    });
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

    const memberIds = Array.from(new Set(params.member_ids ?? []));

    return this.prisma.friend_groups.create({
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

    return this.prisma.friend_group_members.create({
      data: {
        group_id: params.group_id,
        user_id: params.user_id,
      },
    });
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
}
