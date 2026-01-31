import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'please_change_me',
      signOptions: { expiresIn: '7d' },
    }),
  ],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
