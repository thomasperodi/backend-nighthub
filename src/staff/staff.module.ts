import { Module, forwardRef } from '@nestjs/common';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { EventsModule } from '../events/events.module';
import { BadgesModule } from '../badges/badges.module';
import { PushModule } from '../common/push/push.module';
import { VenueStaysModule } from '../venue-stays/venue-stays.module';

@Module({
  imports: [
    forwardRef(() => EventsModule),
    BadgesModule,
    PushModule,
    VenueStaysModule,
  ],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
