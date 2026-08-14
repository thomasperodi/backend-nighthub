import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ContentReportStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';

@Injectable()
export class ModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
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
      status && Object.values(ContentReportStatus).includes(
        status as ContentReportStatus,
      )
        ? (status as ContentReportStatus)
        : undefined;

    return this.prisma.content_reports.findMany({
      where: normalizedStatus ? { status: normalizedStatus } : undefined,
      orderBy: { created_at: 'desc' },
      take: 100,
      include: {
        reporter: { select: { id: true, name: true, email: true } },
        reported_user: {
          select: { id: true, name: true, email: true, is_active: true },
        },
      },
    });
  }

  async resolveReport(params: {
    reportId: string;
    adminId: string;
    status: 'resolved' | 'dismissed';
    resolutionNote?: string;
    suspendReportedUser?: boolean;
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

    return this.prisma.content_reports.update({
      where: { id: params.reportId },
      data: {
        status: params.status,
        resolution_note: params.resolutionNote?.trim() || null,
        resolved_by_admin: params.adminId,
        resolved_at: new Date(),
      },
    });
  }
}
