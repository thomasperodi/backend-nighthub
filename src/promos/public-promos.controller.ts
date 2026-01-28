import { Controller, Get, Param } from '@nestjs/common';
import { PromosService } from './promos.service';

@Controller()
export class PublicPromosController {
  constructor(private readonly promosService: PromosService) {}

  @Get('events/:eventId/promos')
  promosByEvent(@Param('eventId') eventId: string) {
    return this.promosService.listByEvent(eventId);
  }

  @Get('venues/:venueId/promos')
  promosByVenue(@Param('venueId') venueId: string) {
    return this.promosService.listByVenue(venueId);
  }
}
