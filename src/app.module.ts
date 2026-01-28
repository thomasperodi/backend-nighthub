import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { PrismaService } from './prisma/prisma.service'; // importa PrismaService
import { EventsModule } from './events/events.module';
import { StaffModule } from './staff/staff.module';
import { VenuesModule } from './venues/venues.module';
import { ReservationsModule } from './reservations/reservations.module';

@Module({
  imports: [AuthModule, EventsModule, StaffModule, VenuesModule, ReservationsModule],
  controllers: [AppController],
  providers: [AppService, PrismaService], // aggiungi PrismaService
  exports: [PrismaService], // così altri moduli possono usarlo
})
export class AppModule {}
