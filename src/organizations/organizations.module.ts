import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditLogModule } from '../common/audit/audit-log.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { VenuesModule } from '../venues/venues.module';

@Module({
  imports: [
    PrismaModule,
    AuditLogModule,
    // forwardRef: VenuesModule already imports OrganizationsModule - see venues.module.ts.
    forwardRef(() => VenuesModule),
  ],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
