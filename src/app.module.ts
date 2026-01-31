import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { EventsModule } from './events/events.module';
import { StaffModule } from './staff/staff.module';
import { VenuesModule } from './venues/venues.module';
import { ReservationsModule } from './reservations/reservations.module';

@Module({
  imports: [PrismaModule, AuthModule, EventsModule, StaffModule, VenuesModule, ReservationsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
