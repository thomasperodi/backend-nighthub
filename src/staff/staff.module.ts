import { Module, forwardRef } from '@nestjs/common';
import { StaffService } from './staff.service';
import { StaffController } from './staff.controller';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [forwardRef(() => EventsModule)],
  controllers: [StaffController],
  providers: [StaffService],
})
export class StaffModule {}
