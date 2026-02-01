import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'please_change_me',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
