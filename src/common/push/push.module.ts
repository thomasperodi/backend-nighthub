import { Module } from '@nestjs/common';
import { ExpoPushService } from './expo-push.service';
import { WebPushService } from './web-push.service';
import { PushDispatchService } from './push-dispatch.service';

@Module({
  providers: [ExpoPushService, WebPushService, PushDispatchService],
  exports: [ExpoPushService, WebPushService, PushDispatchService],
})
export class PushModule {}
