import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PromosService } from './promos.service';

@Controller()
export class PublicPromosController {
  constructor(private readonly promosService: PromosService) {}

  @Get('events/:eventId/promos')
  promosByEvent(
    @Param('eventId') eventId: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    );
    return this.promosService.listActiveByEvent(eventId);
  }

  @Get('venues/:venueId/promos')
  promosByVenue(
    @Param('venueId') venueId: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=60, stale-while-revalidate=600',
    );
    return this.promosService.listActiveByVenue(venueId);
  }
}
