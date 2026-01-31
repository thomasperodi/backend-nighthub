import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Query,
  BadRequestException,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { StaffService } from './staff.service';
import { RecordEntryDto } from './dto/record-entry.dto';
import { RecordSaleDto } from './dto/record-sale.dto';
import { EventsService } from '../events/events.service';
import { UpdateTableHostessDto } from './dto/update-table-hostess.dto';
import { AddTablePaymentDto } from './dto/add-table-payment.dto';

@Controller('staff')
export class StaffController {
  constructor(
    private readonly staffService: StaffService,
    private readonly eventsService: EventsService,
  ) {}

  @Post('entries')
  recordEntry(@Body() dto: RecordEntryDto) {
    return this.staffService.recordEntry(dto);
  }

  @Get('entries')
  async listEntries(
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
  ) {
    const resolvedEventId = eventId
      ? eventId
      : venueId || staffId
        ? await this.staffService.resolveEventIdForStaffApi({
            venueId,
            staffId,
          })
        : undefined;
    return this.staffService.listEntries(resolvedEventId);
  }

  @Post('bar-sales')
  recordBarSale(@Body() dto: RecordSaleDto) {
    return this.staffService.recordBarSale(dto);
  }

  @Get('bar-sales')
  async listBarSales(
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
  ) {
    const resolvedEventId = eventId
      ? eventId
      : venueId || staffId
        ? await this.staffService.resolveEventIdForStaffApi({
            venueId,
            staffId,
          })
        : undefined;
    return this.staffService.listBarSales(resolvedEventId);
  }

  @Post('cloakroom-sales')
  recordCloakroomSale(@Body() dto: RecordSaleDto) {
    return this.staffService.recordCloakroomSale(dto);
  }

  @Get('cloakroom-sales')
  async listCloakroomSales(
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
  ) {
    const resolvedEventId = eventId
      ? eventId
      : venueId || staffId
        ? await this.staffService.resolveEventIdForStaffApi({
            venueId,
            staffId,
          })
        : undefined;
    return this.staffService.listCloakroomSales(resolvedEventId);
  }

  @Post('table-sales')
  recordTableSale(@Body() dto: RecordSaleDto) {
    return this.staffService.recordTableSale(dto);
  }

  @Get('table-sales')
  async listTableSales(
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
  ) {
    const resolvedEventId = eventId
      ? eventId
      : venueId || staffId
        ? await this.staffService.resolveEventIdForStaffApi({
            venueId,
            staffId,
          })
        : undefined;
    return this.staffService.listTableSales(resolvedEventId);
  }

  @Get('events/:eventId/stats')
  eventStats(
    @Param('eventId') eventId: string,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=5, stale-while-revalidate=30',
    );
    return this.eventsService.getEventStats(eventId);
  }

  // Hostess tables endpoints
  @Get('hostess-tables')
  async listHostessTables(
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
    @Query('onlyBooked') onlyBooked?: string,
  ) {
    const resolvedEventId = eventId
      ? eventId
      : venueId || staffId
        ? await this.staffService.resolveEventIdForStaffApi({
            venueId,
            staffId,
          })
        : undefined;
    return this.staffService.listHostessTables({
      eventId: resolvedEventId,
      venueId,
      onlyBooked: onlyBooked === 'true' || onlyBooked === '1',
    });
  }

  @Post('hostess-tables/:id/update-entrati')
  updateHostessTableEntrati(
    @Param('id') id: string,
    @Body() body: { delta: number },
  ) {
    return this.staffService.updateHostessTableEntrati(id, body?.delta ?? 1);
  }

  @Post('hostess-tables/:id/assign-number')
  assignHostessTableNumber(
    @Param('id') id: string,
    @Body() body: { numero: number },
  ) {
    return this.staffService.assignHostessTableNumber(id, body.numero);
  }

  // Unified endpoint (matches frontend service: PATCH /staff/hostess-tables/:id)
  @Patch('hostess-tables/:id')
  patchHostessTable(
    @Param('id') id: string,
    @Body()
    body: {
      action: 'update_entrati' | 'assign_number';
      delta?: number;
      numero?: number;
    },
  ) {
    if (!body?.action) throw new BadRequestException('action is required');
    if (body.action === 'update_entrati') {
      const d = body.delta ?? 1;
      return this.staffService.updateHostessTableEntrati(id, d);
    }
    if (body.action === 'assign_number') {
      if (body.numero === undefined || body.numero === null) {
        throw new BadRequestException('numero is required');
      }
      return this.staffService.assignHostessTableNumber(id, body.numero);
    }
    throw new BadRequestException('unknown action');
  }

  // Hostess: aggiorna dati tavolo (persone entrate + pagamento iniziale)
  @Patch('hostess/tables/:id')
  updateTableHostess(
    @Param('id') id: string,
    @Body() dto: UpdateTableHostessDto,
  ) {
    return this.staffService.updateTableHostess(id, dto);
  }

  // Cameriere: aggiunge pagamento al tavolo
  @Post('waiter/tables/:id/payment')
  addTablePayment(
    @Param('id') tableId: string,
    @Body() dto: AddTablePaymentDto,
    @Query('staffId') staffId?: string,
    @Query('eventId') eventId?: string,
  ) {
    // staffId/eventId kept for backward compatibility at HTTP level
    // (the tableId already implies the event)
    void staffId;
    void eventId;
    return this.staffService.addTablePayment(tableId, dto.amount);
  }

  // Cameriere: lista tavoli assegnati/visibili
  @Get('waiter/tables')
  async listWaiterTables(
    @Query('userId') userId?: string,
    @Query('staffId') staffId?: string,
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('onlyBooked') onlyBooked?: string,
  ) {
    const effectiveStaffId = staffId ?? userId;
    const resolvedEventId = eventId
      ? eventId
      : venueId || effectiveStaffId
        ? await this.staffService.resolveEventIdForStaffApi({
            venueId,
            staffId: effectiveStaffId,
          })
        : undefined;

    return this.staffService.listWaiterTables({
      eventId: resolvedEventId,
      venueId,
      onlyBooked: onlyBooked === 'true' || onlyBooked === '1',
    });
  }

  // Cameriere: salda il tavolo (completa pagamento)
  @Post('waiter/tables/:id/settle')
  settleTable(@Param('id') tableId: string) {
    return this.staffService.settleTable(tableId);
  }
}
