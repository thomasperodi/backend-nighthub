import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentReportStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { AuditLogService } from '../common/audit/audit-log.service';
import { SupabaseStorageService } from '../common/storage/supabase-storage.service';

const PUBLIC_USER = {
  id: true,
  name: true,
  username: true,
  avatar: true,
} as const;

type CountRow = { _count: { _all?: number } | true | undefined };

@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
    private readonly auditLog: AuditLogService,
    private readonly storage: SupabaseStorageService,
  ) {}

  async fileReport(params: {
    reporterId: string;
    reportedUserId: string;
    reason: string;
  }) {
    const reason = String(params.reason || '').trim();
    if (!reason) throw new BadRequestException('reason required');
    if (reason.length > 500) {
      throw new BadRequestException('reason must be <= 500 chars');
    }
    if (params.reporterId === params.reportedUserId) {
      throw new BadRequestException('Cannot report yourself');
    }

    const reportedUser = await this.prisma.users.findUnique({
      where: { id: params.reportedUserId },
      select: { id: true },
    });
    if (!reportedUser) throw new NotFoundException('Reported user not found');

    // One open report per reporter/user pair: a repeated report updates the reason instead
    // of piling up duplicates that would inflate the count the admin uses to prioritize.
    const open = await this.prisma.content_reports.findFirst({
      where: {
        reporter_id: params.reporterId,
        reported_user_id: params.reportedUserId,
        status: 'pending',
      },
      select: { id: true },
    });
    if (open) {
      return this.prisma.content_reports.update({
        where: { id: open.id },
        data: { reason },
      });
    }

    return this.prisma.content_reports.create({
      data: {
        reporter_id: params.reporterId,
        reported_user_id: params.reportedUserId,
        reason,
      },
    });
  }

  async listReports(status?: string) {
    const normalizedStatus =
      status &&
      Object.values(ContentReportStatus).includes(status as ContentReportStatus)
        ? (status as ContentReportStatus)
        : undefined;

    const reports = await this.prisma.content_reports.findMany({
      where: normalizedStatus ? { status: normalizedStatus } : undefined,
      orderBy: { created_at: 'desc' },
      take: 100,
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        // Photo and username are what the admin has to review; the email identifies the account.
        reported_user: {
          select: {
            id: true,
            name: true,
            email: true,
            username: true,
            avatar: true,
            is_active: true,
          },
        },
      },
    });

    // Signals to prioritize, as counts only: who blocked whom stays private.
    const userIds = Array.from(new Set(reports.map((r) => r.reported_user_id)));
    const [reportCounts, pendingCounts, blockCounts] = userIds.length
      ? await this.prisma.$transaction([
          this.prisma.content_reports.groupBy({
            by: ['reported_user_id'],
            where: { reported_user_id: { in: userIds } },
            orderBy: { reported_user_id: 'asc' },
            _count: { _all: true },
          }),
          this.prisma.content_reports.groupBy({
            by: ['reported_user_id'],
            where: { reported_user_id: { in: userIds }, status: 'pending' },
            orderBy: { reported_user_id: 'asc' },
            _count: { _all: true },
          }),
          this.prisma.user_blocks.groupBy({
            by: ['blocked_id'],
            where: { blocked_id: { in: userIds } },
            orderBy: { blocked_id: 'asc' },
            _count: { _all: true },
          }),
        ])
      : [[], [], []];

    const counts = (rows: CountRow[], key: 'reported_user_id' | 'blocked_id') =>
      new Map(
        rows.map((row) => [
          String((row as Record<string, unknown>)[key]),
          typeof row._count === 'object' ? (row._count._all ?? 0) : 0,
        ]),
      );
    const total = counts(reportCounts, 'reported_user_id');
    const pending = counts(pendingCounts, 'reported_user_id');
    const blocked = counts(blockCounts, 'blocked_id');

    return reports.map((report) => ({
      ...report,
      reported_user_stats: {
        reports_total: total.get(report.reported_user_id) ?? 0,
        reports_pending: pending.get(report.reported_user_id) ?? 0,
        blocked_by_count: blocked.get(report.reported_user_id) ?? 0,
      },
    }));
  }

  async resolveReport(params: {
    reportId: string;
    adminId: string;
    status: 'resolved' | 'dismissed';
    resolutionNote?: string;
    suspendReportedUser?: boolean;
    removeAvatar?: boolean;
  }) {
    const report = await this.prisma.content_reports.findUnique({
      where: { id: params.reportId },
    });
    if (!report) throw new NotFoundException('Report not found');

    if (params.suspendReportedUser) {
      await this.adminService.setUserActive(
        report.reported_user_id,
        false,
        params.adminId,
      );
    }

    if (params.removeAvatar) {
      await this.removeAvatar(report.reported_user_id, params.adminId);
    }

    const updated = await this.prisma.content_reports.update({
      where: { id: params.reportId },
      data: {
        status: params.status,
        resolution_note: params.resolutionNote?.trim() || null,
        resolved_by_admin: params.adminId,
        resolved_at: new Date(),
      },
    });

    // The outcome of every report shows up in the admin audit log, with the reason, so the
    // moderation history is readable there and not only in the reports list.
    this.auditLog.record({
      adminId: params.adminId,
      action: `report.${params.status}`,
      targetType: 'user',
      targetId: report.reported_user_id,
      metadata: {
        report_id: report.id,
        reason: report.reason,
        note: updated.resolution_note,
        suspended: Boolean(params.suspendReportedUser),
        avatar_removed: Boolean(params.removeAvatar),
      },
    });
    return updated;
  }

  /** Removes an inappropriate profile photo without suspending the account. */
  private async removeAvatar(userId: string, adminId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { avatar: true },
    });
    if (!user?.avatar) return;

    await this.prisma.users.update({
      where: { id: userId },
      data: { avatar: null },
    });
    // Only images in our own bucket (`users/...`): external URLs are not ours to delete.
    if (user.avatar.startsWith('users/')) {
      void this.storage.deletePublicImage(user.avatar).catch(() => undefined);
    }
    this.auditLog.record({
      adminId,
      action: 'user.avatar_removed',
      targetType: 'user',
      targetId: userId,
    });
  }

  // ── Blocks ────────────────────────────────────────────────────────────────

  async listBlocks(userId: string) {
    const rows = await this.prisma.user_blocks.findMany({
      where: { blocker_id: userId },
      orderBy: { created_at: 'desc' },
      select: { created_at: true, blocked: { select: PUBLIC_USER } },
    });
    return rows.map((row) => ({ ...row.blocked, blocked_at: row.created_at }));
  }

  /**
   * Idempotent. Severs every link between the two users in one transaction: friendship
   * (both rows), friend requests in either direction (hard delete, so neither side can tell
   * a block apart from a request that was never sent), and membership in each other's
   * groups. The blocked user is not notified.
   */
  async blockUser(blockerId: string, blockedId: string) {
    if (!blockedId) throw new BadRequestException('user_id required');
    if (blockerId === blockedId) {
      throw new BadRequestException('Cannot block yourself');
    }
    const target = await this.prisma.users.findUnique({
      where: { id: blockedId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('User not found');

    await this.prisma.$transaction([
      this.prisma.user_blocks.upsert({
        where: {
          blocker_id_blocked_id: {
            blocker_id: blockerId,
            blocked_id: blockedId,
          },
        },
        create: { blocker_id: blockerId, blocked_id: blockedId },
        update: {},
      }),
      this.prisma.friendships.deleteMany({
        where: {
          OR: [
            { user_id: blockerId, friend_id: blockedId },
            { user_id: blockedId, friend_id: blockerId },
          ],
        },
      }),
      this.prisma.friend_requests.deleteMany({
        where: {
          OR: [
            { from_user_id: blockerId, to_user_id: blockedId },
            { from_user_id: blockedId, to_user_id: blockerId },
          ],
        },
      }),
      this.prisma.friend_group_members.deleteMany({
        where: {
          OR: [
            { user_id: blockedId, group: { owner_id: blockerId } },
            { user_id: blockerId, group: { owner_id: blockedId } },
          ],
        },
      }),
    ]);

    return { success: true };
  }

  async unblockUser(blockerId: string, blockedId: string) {
    await this.prisma.user_blocks.deleteMany({
      where: { blocker_id: blockerId, blocked_id: blockedId },
    });
    return { success: true };
  }
}
