import {
  Body,
  Controller,
  ForbiddenException,
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
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';

@Controller('staff')
@Roles('staff', 'venue', 'admin')
export class StaffController {
  constructor(
    private readonly staffService: StaffService,
    private readonly eventsService: EventsService,
  ) {}

  @Post('entries')
  async recordEntry(@Body() dto: RecordEntryDto, @CurrentUser() user: RequestUser) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      const payload = dto as unknown as {
        staff_id?: string;
        event_id?: string;
        eventId?: string;
      };
      payload.staff_id = user.id;
      const eventId = payload.event_id ?? payload.eventId;
      if (eventId) {
        await this.staffService.assertEventBelongsToVenue(eventId, user.venue_id);
      }
    }
    return this.staffService.recordEntry(dto);
  }

  @Get('entries')
  async listEntries(
    @CurrentUser() user: RequestUser,
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
  ) {
    const isAdmin = user.role === 'admin';
    const effectiveVenueId: string | undefined = isAdmin
      ? venueId
      : user.venue_id ?? undefined;
    if (!isAdmin && !effectiveVenueId) throw new ForbiddenException('Missing venue_id');

    const resolvedEventId = await this.staffService.resolveEventIdForStaffApi({
      eventId,
      venueId: effectiveVenueId,
      staffId: isAdmin ? staffId : undefined,
    });

    if (!isAdmin && effectiveVenueId) {
      await this.staffService.assertEventBelongsToVenue(resolvedEventId, effectiveVenueId);
    }
    return this.staffService.listEntries(resolvedEventId);
  }

  @Post('bar-sales')
  async recordBarSale(@Body() dto: RecordSaleDto, @CurrentUser() user: RequestUser) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      const payload = dto as unknown as {
        staff_id?: string;
        event_id?: string;
        eventId?: string;
      };
      payload.staff_id = user.id;
      const eventId = payload.event_id ?? payload.eventId;
      if (eventId) {
        await this.staffService.assertEventBelongsToVenue(eventId, user.venue_id);
      }
    }
    return this.staffService.recordBarSale(dto);
  }

  @Get('bar-sales')
  async listBarSales(
    @CurrentUser() user: RequestUser,
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
  ) {
    const isAdmin = user.role === 'admin';
    const effectiveVenueId: string | undefined = isAdmin
      ? venueId
      : user.venue_id ?? undefined;
    if (!isAdmin && !effectiveVenueId) throw new ForbiddenException('Missing venue_id');

    const resolvedEventId = await this.staffService.resolveEventIdForStaffApi({
      eventId,
      venueId: effectiveVenueId,
      staffId: isAdmin ? staffId : undefined,
    });

    if (!isAdmin && effectiveVenueId) {
      await this.staffService.assertEventBelongsToVenue(resolvedEventId, effectiveVenueId);
    }
    return this.staffService.listBarSales(resolvedEventId);
  }

  @Post('cloakroom-sales')
  async recordCloakroomSale(
    @Body() dto: RecordSaleDto,
    @CurrentUser() user: RequestUser,
  ) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      const payload = dto as unknown as {
        staff_id?: string;
        event_id?: string;
        eventId?: string;
      };
      payload.staff_id = user.id;
      const eventId = payload.event_id ?? payload.eventId;
      if (eventId) {
        await this.staffService.assertEventBelongsToVenue(eventId, user.venue_id);
      }
    }
    return this.staffService.recordCloakroomSale(dto);
  }

  @Get('cloakroom-sales')
  async listCloakroomSales(
    @CurrentUser() user: RequestUser,
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
  ) {
    const isAdmin = user.role === 'admin';
    const effectiveVenueId: string | undefined = isAdmin
      ? venueId
      : user.venue_id ?? undefined;
    if (!isAdmin && !effectiveVenueId) throw new ForbiddenException('Missing venue_id');

    const resolvedEventId = await this.staffService.resolveEventIdForStaffApi({
      eventId,
      venueId: effectiveVenueId,
      staffId: isAdmin ? staffId : undefined,
    });

    if (!isAdmin && effectiveVenueId) {
      await this.staffService.assertEventBelongsToVenue(resolvedEventId, effectiveVenueId);
    }
    return this.staffService.listCloakroomSales(resolvedEventId);
  }

  @Post('table-sales')
  async recordTableSale(@Body() dto: RecordSaleDto, @CurrentUser() user: RequestUser) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      const payload = dto as unknown as {
        staff_id?: string;
        event_table_id?: string;
      };
      payload.staff_id = user.id;
      const eventTableId = payload.event_table_id;
      if (eventTableId) {
        await this.staffService.assertEventTableBelongsToVenue(
          eventTableId,
          user.venue_id,
        );
      }
    }
    return this.staffService.recordTableSale(dto);
  }

  @Get('table-sales')
  async listTableSales(
    @CurrentUser() user: RequestUser,
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
  ) {
    const isAdmin = user.role === 'admin';
    const effectiveVenueId: string | undefined = isAdmin
      ? venueId
      : user.venue_id ?? undefined;
    if (!isAdmin && !effectiveVenueId) throw new ForbiddenException('Missing venue_id');

    const resolvedEventId = await this.staffService.resolveEventIdForStaffApi({
      eventId,
      venueId: effectiveVenueId,
      staffId: isAdmin ? staffId : undefined,
    });

    if (!isAdmin && effectiveVenueId) {
      await this.staffService.assertEventBelongsToVenue(resolvedEventId, effectiveVenueId);
    }
    return this.staffService.listTableSales(resolvedEventId);
  }

  @Get('events/:eventId/stats')
  eventStats(
    @Param('eventId') eventId: string,
    @CurrentUser() user: RequestUser,
    @Res({ passthrough: true }) res?: Response,
  ) {
    res?.setHeader(
      'Cache-Control',
      'public, max-age=0, s-maxage=5, stale-while-revalidate=30',
    );
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      return this.staffService
        .assertEventBelongsToVenue(eventId, user.venue_id)
        .then(() => this.eventsService.getEventStats(eventId));
    }
    return this.eventsService.getEventStats(eventId);
  }

  // Hostess tables endpoints
  @Get('hostess-tables')
  async listHostessTables(
    @CurrentUser() user: RequestUser,
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('staffId') staffId?: string,
    @Query('onlyBooked') onlyBooked?: string,
  ) {
    const isAdmin = user.role === 'admin';
    const effectiveVenueId: string | undefined = isAdmin
      ? venueId
      : user.venue_id ?? undefined;
    if (!isAdmin && !effectiveVenueId) throw new ForbiddenException('Missing venue_id');

    const resolvedEventId = await this.staffService.resolveEventIdForStaffApi({
      eventId,
      venueId: effectiveVenueId,
      staffId: isAdmin ? staffId : undefined,
    });

    if (!isAdmin && effectiveVenueId) {
      await this.staffService.assertEventBelongsToVenue(resolvedEventId, effectiveVenueId);
    }
    return this.staffService.listHostessTables({
      eventId: resolvedEventId,
      venueId: effectiveVenueId,
      onlyBooked: onlyBooked === 'true' || onlyBooked === '1',
    });
  }

  @Post('hostess-tables/:id/update-entrati')
  updateHostessTableEntrati(
    @Param('id') id: string,
    @Body() body: { delta: number },
    @CurrentUser() user: RequestUser,
  ) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      return this.staffService
        .assertEventTableBelongsToVenue(id, user.venue_id)
        .then(() => this.staffService.updateHostessTableEntrati(id, body?.delta ?? 1));
    }
    return this.staffService.updateHostessTableEntrati(id, body?.delta ?? 1);
  }

  @Post('hostess-tables/:id/assign-number')
  assignHostessTableNumber(
    @Param('id') id: string,
    @Body() body: { numero: number },
    @CurrentUser() user: RequestUser,
  ) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      return this.staffService
        .assertEventTableBelongsToVenue(id, user.venue_id)
        .then(() => this.staffService.assignHostessTableNumber(id, body.numero));
    }
    return this.staffService.assignHostessTableNumber(id, body.numero);
  }

  // Unified endpoint (matches frontend service: PATCH /staff/hostess-tables/:id)
  @Patch('hostess-tables/:id')
  async patchHostessTable(
    @Param('id') id: string,
    @Body()
    body: {
      action: 'update_entrati' | 'assign_number';
      delta?: number;
      numero?: number;
    },
    @CurrentUser() user: RequestUser,
  ) {
    const authz = async () => {
      if (user.role === 'admin') return;
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      await this.staffService.assertEventTableBelongsToVenue(id, user.venue_id);
    };

    if (!body?.action) throw new BadRequestException('action is required');
    await authz();

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
    @CurrentUser() user: RequestUser,
  ) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      return this.staffService
        .assertEventTableBelongsToVenue(id, user.venue_id)
        .then(() => this.staffService.updateTableHostess(id, dto));
    }
    return this.staffService.updateTableHostess(id, dto);
  }

  // Cameriere: aggiunge pagamento al tavolo
  @Post('waiter/tables/:id/payment')
  addTablePayment(
    @Param('id') tableId: string,
    @Body() dto: AddTablePaymentDto,
    @CurrentUser() user: RequestUser,
    @Query('staffId') staffId?: string,
    @Query('eventId') eventId?: string,
  ) {
    // staffId/eventId kept for backward compatibility at HTTP level
    // (the tableId already implies the event)
    void staffId;
    void eventId;
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      return this.staffService
        .assertEventTableBelongsToVenue(tableId, user.venue_id)
        .then(() => this.staffService.addTablePayment(tableId, dto.amount));
    }
    return this.staffService.addTablePayment(tableId, dto.amount);
  }

  // Cameriere: lista tavoli assegnati/visibili
  @Get('waiter/tables')
  async listWaiterTables(
    @CurrentUser() user: RequestUser,
    @Query('userId') userId?: string,
    @Query('staffId') staffId?: string,
    @Query('eventId') eventId?: string,
    @Query('venueId') venueId?: string,
    @Query('onlyBooked') onlyBooked?: string,
  ) {
    const isAdmin = user.role === 'admin';
    const effectiveStaffId = isAdmin ? (staffId ?? userId) : undefined;
    const effectiveVenueId: string | undefined = isAdmin
      ? venueId
      : user.venue_id ?? undefined;
    if (!isAdmin && !effectiveVenueId) throw new ForbiddenException('Missing venue_id');

    const resolvedEventId = await this.staffService.resolveEventIdForStaffApi({
      eventId,
      venueId: effectiveVenueId,
      staffId: effectiveStaffId,
    });

    if (!isAdmin && effectiveVenueId) {
      await this.staffService.assertEventBelongsToVenue(resolvedEventId, effectiveVenueId);
    }

    return this.staffService.listWaiterTables({
      eventId: resolvedEventId,
      venueId: effectiveVenueId,
      onlyBooked: onlyBooked === 'true' || onlyBooked === '1',
    });
  }

  // Cameriere: salda il tavolo (completa pagamento)
  @Post('waiter/tables/:id/settle')
  async settleTableSecured(
    @Param('id') tableId: string,
    @CurrentUser() user: RequestUser,
  ) {
    if (user.role !== 'admin') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      await this.staffService.assertEventTableBelongsToVenue(tableId, user.venue_id);
    }
    return this.staffService.settleTable(tableId);
  }
}
