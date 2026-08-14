import { Module } from '@nestjs/common';
import { FriendsController } from './friends.controller';
import { FriendsService } from './friends.service';
import { ReservationsModule } from '../reservations/reservations.module';
import { BadgesModule } from '../badges/badges.module';
import { PushModule } from '../common/push/push.module';

@Module({
  imports: [ReservationsModule, BadgesModule, PushModule],
  controllers: [FriendsController],
  providers: [FriendsService],
  exports: [FriendsService],
})
export class FriendsModule {}
