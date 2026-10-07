import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminModule } from '../admin/admin.module';
import { AuditLogModule } from '../common/audit/audit-log.module';
import { ModerationController } from './moderation.controller';
import { ModerationService } from './moderation.service';

@Module({
  imports: [PrismaModule, AdminModule, AuditLogModule],
  controllers: [ModerationController],
  providers: [ModerationService],
})
export class ModerationModule {}
