import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { PushModule } from '../common/push/push.module';
import { AttendanceForecastService } from './attendance-forecast.service';

@Module({
  imports: [AuthModule, PushModule],
  controllers: [EventsController],
  providers: [EventsService, AttendanceForecastService],
  exports: [EventsService],
})
export class EventsModule {}
