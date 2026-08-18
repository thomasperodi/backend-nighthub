import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
import { PromosModule } from './promos/promos.module';
import { StorageModule } from './common/storage/storage.module';
import { AdminModule } from './admin/admin.module';
import { UsersModule } from './users/users.module';
import { BadgesModule } from './badges/badges.module';
import { ModerationModule } from './moderation/moderation.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';

@Module({
  imports: [
    // Global default rate limit (120 req/min per IP) as a generic abuse backstop; the
    // sensitive auth endpoints (login/register/refresh/forgot-password/reset-password)
    // additionally set their own tighter @Throttle() limits in AuthController. Storage is
    // in-memory (default), which is best-effort on serverless (Vercel): each cold instance
    // starts its own counters, so this does not give a hard distributed guarantee. A
    // shared store (e.g. Redis) would close that gap but was deliberately left out of this
    // iteration - see AUTH AUDIT follow-ups.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
    PrismaModule,
    StorageModule,
    AuthModule,
    EventsModule,
    StaffModule,
    VenuesModule,
    ReservationsModule,
    VenueStaysModule,
    FriendsModule,
    PromosModule,
    AdminModule,
    UsersModule,
    BadgesModule,
    ModerationModule,
    OrganizationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
