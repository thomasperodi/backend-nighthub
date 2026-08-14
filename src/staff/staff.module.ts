import { Module, forwardRef } from '@nestjs/common';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { EventsModule } from '../events/events.module';
import { BadgesModule } from '../badges/badges.module';
import { PushModule } from '../common/push/push.module';

@Module({
  imports: [forwardRef(() => EventsModule), BadgesModule, PushModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
