import { Module, forwardRef } from '@nestjs/common';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';
import { EventsModule } from '../events/events.module';
import { BadgesModule } from '../badges/badges.module';
import { AuditLogModule } from '../common/audit/audit-log.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [
    EventsModule,
    BadgesModule,
    AuditLogModule,
    // forwardRef: OrganizationsModule now also imports VenuesModule (to reuse
    // create/update/deleteOrganizationPrMember for its own PR-network endpoints) - see
    // organizations.module.ts.
    forwardRef(() => OrganizationsModule),
  ],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService],
})
export class VenuesModule {}
