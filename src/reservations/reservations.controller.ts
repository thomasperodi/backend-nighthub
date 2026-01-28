import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get()
  list(
    @Query('event_id') eventIdSnake?: string,
    @Query('eventId') eventIdCamel?: string,
    @Query('user_id') userIdSnake?: string,
    @Query('userId') userIdCamel?: string,
  ) {
    return this.reservationsService.listReservations({
      eventId: eventIdSnake ?? eventIdCamel,
      userId: userIdSnake ?? userIdCamel,
    });
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.reservationsService.getReservation(id);
  }

  @Post()
  create(@Body() body: any) {
    return this.reservationsService.createReservation(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.reservationsService.updateReservation(id, body);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string) {
    return this.reservationsService.cancelReservation(id);
  }
}
