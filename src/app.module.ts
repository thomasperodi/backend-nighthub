import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';
import { EventsModule } from './events/events.module';
import { StaffModule } from './staff/staff.module';
import { VenuesModule } from './venues/venues.module';
import { ReservationsModule } from './reservations/reservations.module';
import { VenueStaysModule } from './venue-stays/venue-stays.module';
import { FriendsModule } from './friends/friends.module';
import { StorageModule } from './common/storage/storage.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';

@Module({
  imports: [
    PrismaModule,
    StorageModule,
    AuthModule,
    EventsModule,
    StaffModule,
    VenuesModule,
    ReservationsModule,
    VenueStaysModule,
    FriendsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
