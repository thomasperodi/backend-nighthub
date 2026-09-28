import { Module } from '@nestjs/common';
import { VenueStaysController } from './venue-stays.controller';
import { VenueStaysService } from './venue-stays.service';
import { PushModule } from '../common/push/push.module';

@Module({
  imports: [PushModule],
  controllers: [VenueStaysController],
  providers: [VenueStaysService],
  exports: [VenueStaysService],
})
export class VenueStaysModule {}
