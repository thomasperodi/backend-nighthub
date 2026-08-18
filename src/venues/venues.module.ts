import { Module } from '@nestjs/common';
import { VenuesController } from './venues.controller';
import { VenuesService } from './venues.service';
import { EventsModule } from '../events/events.module';
import { BadgesModule } from '../badges/badges.module';
import { AuditLogModule } from '../common/audit/audit-log.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [EventsModule, BadgesModule, AuditLogModule, OrganizationsModule],
  controllers: [VenuesController],
  providers: [VenuesService],
  exports: [VenuesService],
})
export class VenuesModule {}
