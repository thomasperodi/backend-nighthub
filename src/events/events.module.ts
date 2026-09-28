import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { PushModule } from '../common/push/push.module';
import { AttendanceForecastService } from './attendance-forecast.service';
import { VenueStaysModule } from '../venue-stays/venue-stays.module';

@Module({
  imports: [AuthModule, PushModule, VenueStaysModule],
  controllers: [EventsController],
  providers: [EventsService, AttendanceForecastService],
  exports: [EventsService],
})
export class EventsModule {}
