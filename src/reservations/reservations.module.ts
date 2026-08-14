import { Module } from '@nestjs/common';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { BadgesModule } from '../badges/badges.module';
import { PushModule } from '../common/push/push.module';

@Module({
  imports: [BadgesModule, PushModule],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
