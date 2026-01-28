import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { PromosService } from './promos.service';

@Controller('promos')
export class PromosController {
  constructor(private readonly promosService: PromosService) {}

  @Get()
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.promosService.listPromos();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.promosService.getPromo(id);
  }

  @Get('/by-event/:eventId')
  byEvent(@Param('eventId') eventId: string) {
    return this.promosService.listByEvent(eventId);
  }

  @Get('/by-venue/:venueId')
  byVenue(@Param('venueId') venueId: string) {
    return this.promosService.listByVenue(venueId);
  }

  @Post()
  create(@Body() body: any) {
    return this.promosService.createPromo(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.promosService.updatePromo(id, body);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.promosService.deletePromo(id);
  }
}
