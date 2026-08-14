import { Module } from '@nestjs/common';
import { FriendsController } from './friends.controller';
import { FriendsService } from './friends.service';
import { ReservationsModule } from '../reservations/reservations.module';
import { BadgesModule } from '../badges/badges.module';

@Module({
  imports: [ReservationsModule, BadgesModule],
  controllers: [FriendsController],
  providers: [FriendsService],
  exports: [FriendsService],
})
export class FriendsModule {}
