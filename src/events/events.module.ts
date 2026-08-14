import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { ExpoPushService } from '../common/push/expo-push.service';

@Module({
  imports: [AuthModule],
  controllers: [EventsController],
  providers: [EventsService, ExpoPushService],
  exports: [EventsService],
})
export class EventsModule {}
