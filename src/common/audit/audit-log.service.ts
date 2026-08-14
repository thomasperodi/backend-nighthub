import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Fire-and-forget by design (mirrors touchUserActivity in JwtAuthGuard): a slow/failed
  // audit write must never block or fail the admin action it's recording.
  record(params: {
    adminId: string;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
  }) {
    void this.prisma.admin_audit_logs
      .create({
        data: {
          admin_id: params.adminId,
          action: params.action,
          target_type: params.targetType,
          target_id: params.targetId,
          metadata: params.metadata as Prisma.InputJsonValue | undefined,
        },
      })
      .catch((error) => {
        this.logger.warn(`Failed to write audit log: ${String(error)}`);
      });
  }
}
