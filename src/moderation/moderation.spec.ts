import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { FriendsService } from '../friends/friends.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AdminService } from '../admin/admin.service';
import type { AuditLogService } from '../common/audit/audit-log.service';
import type { SupabaseStorageService } from '../common/storage/supabase-storage.service';
import type { ReservationsService } from '../reservations/reservations.service';
import type { BadgesService } from '../badges/badges.service';
import type { PushDispatchService } from '../common/push/push-dispatch.service';

function setup() {
  const prisma = {
    users: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'bob', avatar: 'users/bob.jpg' }),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    user_blocks: {
      upsert: jest.fn().mockReturnValue('upsert'),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockReturnValue('blocks-groupBy'),
    },
    friendships: {
      deleteMany: jest.fn().mockReturnValue('friendships'),
      findMany: jest.fn().mockReturnValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    friend_requests: {
      deleteMany: jest.fn().mockReturnValue('requests'),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'req-1' }),
    },
    friend_group_members: { deleteMany: jest.fn().mockReturnValue('groups') },
    content_reports: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'r1', reported_user_id: 'bob' }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(({ data }) => Promise.resolve({ id: 'r1', ...data })),
      update: jest.fn(({ data }) => Promise.resolve({ id: 'r1', ...data })),
      groupBy: jest.fn().mockReturnValue('reports-groupBy'),
    },
    venue_pr_memberships: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((ops: unknown) =>
      Promise.resolve(Array.isArray(ops) ? ops.map(() => []) : ops),
    ),
  };
  const admin = { setUserActive: jest.fn() };
  const audit = { record: jest.fn() };
  const storage = { deletePublicImage: jest.fn().mockResolvedValue(undefined) };
  const moderation = new ModerationService(
    prisma as unknown as PrismaService,
    admin as unknown as AdminService,
    audit as unknown as AuditLogService,
    storage as unknown as SupabaseStorageService,
  );
  const friends = new FriendsService(
    prisma as unknown as PrismaService,
    {} as ReservationsService,
    {} as BadgesService,
    { notifyUser: jest.fn() } as unknown as PushDispatchService,
  );
  return { prisma, admin, audit, storage, moderation, friends };
}

describe('Blocks', () => {
  it('blocking severs friendship, requests and shared groups in one transaction', async () => {
    const { moderation, prisma } = setup();
    await moderation.blockUser('alice', 'bob');

    expect(prisma.$transaction).toHaveBeenCalledWith([
      'upsert',
      'friendships',
      'requests',
      'groups',
    ]);
    expect(prisma.friendships.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { user_id: 'alice', friend_id: 'bob' },
          { user_id: 'bob', friend_id: 'alice' },
        ],
      },
    });
    expect(prisma.friend_requests.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { from_user_id: 'alice', to_user_id: 'bob' },
          { from_user_id: 'bob', to_user_id: 'alice' },
        ],
      },
    });
  });

  it('cannot block yourself or a missing user', async () => {
    const { moderation, prisma } = setup();
    await expect(moderation.blockUser('alice', 'alice')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    prisma.users.findUnique.mockResolvedValueOnce(null);
    await expect(moderation.blockUser('alice', 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('unblocking only removes the caller’s own block', async () => {
    const { moderation, prisma } = setup();
    await moderation.unblockUser('alice', 'bob');
    expect(prisma.user_blocks.deleteMany).toHaveBeenCalledWith({
      where: { blocker_id: 'alice', blocked_id: 'bob' },
    });
  });

  it('search hides users in either direction of a block', async () => {
    const { friends, prisma } = setup();
    prisma.user_blocks.findMany.mockResolvedValueOnce([
      { blocker_id: 'alice', blocked_id: 'bob' },
      { blocker_id: 'carl', blocked_id: 'alice' },
    ]);
    prisma.users.findMany.mockReturnValue('candidates');
    await friends.searchUsers('ma', 'alice');
    const [args] = prisma.users.findMany.mock.calls[0] as [
      { where: { id: unknown } },
    ];
    expect(args.where.id).toEqual({ notIn: ['alice', 'bob', 'carl'] });
  });

  it('a blocked user gets "not found" when sending a request, like a missing user', async () => {
    const { friends, prisma } = setup();
    prisma.users.findUnique.mockResolvedValueOnce({ id: 'alice' });
    prisma.user_blocks.findMany.mockResolvedValueOnce([
      { blocker_id: 'alice', blocked_id: 'bob' },
    ]);
    await expect(
      friends.sendRequest({ from_user_id: 'bob', user_id: 'alice' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.friend_requests.create).not.toHaveBeenCalled();
  });
});

describe('Reports', () => {
  it('a second report on the same user updates the open one instead of duplicating', async () => {
    const { moderation, prisma } = setup();
    prisma.content_reports.findFirst.mockResolvedValueOnce({ id: 'open-1' });
    await moderation.fileReport({
      reporterId: 'alice',
      reportedUserId: 'bob',
      reason: 'Spam',
    });
    expect(prisma.content_reports.update).toHaveBeenCalledWith({
      where: { id: 'open-1' },
      data: { reason: 'Spam' },
    });
    expect(prisma.content_reports.create).not.toHaveBeenCalled();
  });

  it('admin list adds counts per reported user, never who blocked them', async () => {
    const { moderation, prisma } = setup();
    prisma.content_reports.findMany.mockResolvedValueOnce([
      { id: 'r1', reported_user_id: 'bob' },
    ]);
    prisma.$transaction.mockResolvedValueOnce([
      [{ reported_user_id: 'bob', _count: { _all: 3 } }],
      [{ reported_user_id: 'bob', _count: { _all: 2 } }],
      [{ blocked_id: 'bob', _count: { _all: 4 } }],
    ]);
    const [row] = await moderation.listReports('pending');
    expect(row.reported_user_stats).toEqual({
      reports_total: 3,
      reports_pending: 2,
      blocked_by_count: 4,
    });
  });

  it('resolving can remove the profile photo, with an audit entry', async () => {
    const { moderation, prisma, storage, audit } = setup();
    await moderation.resolveReport({
      reportId: 'r1',
      adminId: 'admin',
      status: 'resolved',
      removeAvatar: true,
    });
    expect(prisma.users.update).toHaveBeenCalledWith({
      where: { id: 'bob' },
      data: { avatar: null },
    });
    expect(storage.deletePublicImage).toHaveBeenCalledWith('users/bob.jpg');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.avatar_removed',
        targetId: 'bob',
      }),
    );
  });
});
