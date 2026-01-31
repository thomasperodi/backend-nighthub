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
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const eventId = eventIdSnake ?? eventIdCamel;
    const userId = userIdSnake ?? userIdCamel;

    if (page || pageSize) {
      const pageNum = page ? parseInt(page, 10) || 1 : 1;
      const pageSizeNum = pageSize ? parseInt(pageSize, 10) || 20 : 20;
      return this.reservationsService.listReservationsPaginated(pageNum, pageSizeNum, {
        eventId,
        userId,
      });
    }

    return this.reservationsService.listReservations({ eventId, userId });
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
