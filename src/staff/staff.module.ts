import { Module, forwardRef } from '@nestjs/common';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { EventsModule } from '../events/events.module';
import { BadgesModule } from '../badges/badges.module';

@Module({
  imports: [forwardRef(() => EventsModule), BadgesModule],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
