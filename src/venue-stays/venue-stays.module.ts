import { Module } from '@nestjs/common';
import { VenueStaysController } from './venue-stays.controller';
import { VenueStaysService } from './venue-stays.service';

@Module({
  controllers: [VenueStaysController],
  providers: [VenueStaysService],
  exports: [VenueStaysService],
})
export class VenueStaysModule {}
