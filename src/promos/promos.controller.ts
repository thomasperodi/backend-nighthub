import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ForbiddenException,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PromosService } from './promos.service';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../auth/current-user.decorator';
import type { RequestUser } from '../auth/types';
import { CreatePromoDto, UpdatePromoDto } from './dto/promo.dto';

/**
 * Promo management:
 * - venue: every promo of its own venue (venue-wide or tied to one of its nights)
 * - organization: only promos on the nights it created (event_id required)
 * - admin: everything
 */
@Controller('promos')
@Roles('venue', 'organization', 'admin')
export class PromosController {
  constructor(private readonly promosService: PromosService) {}

  @Get('active')
  @Roles('client', 'venue', 'admin')
  active(@CurrentUser() user: RequestUser) {
    if (user.role === 'admin') return this.promosService.listActivePromos();
    if (user.role === 'venue') {
      if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
      return this.promosService.listActiveByVenue(user.venue_id);
    }
    return this.promosService.listActivePromosForUser(user.id);
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    if (user.role === 'admin') return this.promosService.listPromos();
    if (user.role === 'organization') {
      return this.promosService.listByOrganization(this.orgId(user));
    }
    return this.promosService.listByVenue(this.venueId(user));
  }

  @Get(':id')
  async get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    const promo = await this.promosService.getPromo(id);
    await this.assertCanManage(promo, user);
    return promo;
  }

  @Get('/by-event/:eventId')
  async byEvent(
    @Param('eventId', new ParseUUIDPipe({ version: '4' })) eventId: string,
    @CurrentUser() user: RequestUser,
  ) {
    if (user.role === 'admin') return this.promosService.listByEvent(eventId);
    if (user.role === 'organization') {
      await this.promosService.assertEventBelongsToOrganization(
        eventId,
        this.orgId(user),
      );
      return this.promosService.listByEvent(eventId);
    }
    return this.promosService.listByEventForVenue(eventId, this.venueId(user));
  }

  @Get('/by-venue/:venueId')
  byVenue(@Param('venueId') venueId: string, @CurrentUser() user: RequestUser) {
    if (user.role === 'admin') return this.promosService.listByVenue(venueId);
    if (venueId !== this.venueId(user))
      throw new ForbiddenException('Forbidden');
    return this.promosService.listByVenue(venueId);
  }

  @Post()
  async create(@Body() dto: CreatePromoDto, @CurrentUser() user: RequestUser) {
    let venueId: string;
    if (user.role === 'organization') {
      if (!dto.event_id) {
        throw new BadRequestException(
          'Scegli la serata a cui si applica la promo.',
        );
      }
      venueId = await this.promosService.assertEventBelongsToOrganization(
        dto.event_id,
        this.orgId(user),
      );
    } else if (user.role === 'venue') {
      venueId = this.venueId(user);
      if (dto.event_id) {
        await this.promosService.assertEventBelongsToVenue(
          dto.event_id,
          venueId,
        );
      }
    } else {
      if (!dto.venue_id) throw new BadRequestException('venue_id required');
      venueId = dto.venue_id;
    }

    return this.promosService.createPromo(
      {
        venue_id: venueId,
        event_id: dto.event_id,
        title: dto.title,
        description: dto.description,
        discount_type: dto.discount_type,
        discount_value: dto.discount_value,
      },
      dto.audience,
    );
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdatePromoDto,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertCanManage(await this.promosService.getPromo(id), user);
    // venue_id / event_id are not editable: a promo never moves to another venue or night.
    return this.promosService.updatePromo(id, dto);
  }

  @Delete(':id')
  async delete(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: RequestUser,
  ) {
    await this.assertCanManage(await this.promosService.getPromo(id), user);
    return this.promosService.deletePromo(id);
  }

  private venueId(user: RequestUser): string {
    if (!user.venue_id) throw new ForbiddenException('Missing venue_id');
    return user.venue_id;
  }

  private orgId(user: RequestUser): string {
    if (!user.organization_id)
      throw new ForbiddenException('Missing organization_id');
    return user.organization_id;
  }

  private async assertCanManage(
    promo: { venue_id: string; event_id: string | null },
    user: RequestUser,
  ) {
    if (user.role === 'admin') return;
    if (user.role === 'organization') {
      // Venue-wide promos (no event) belong to the venue, never to an organization.
      if (!promo.event_id) throw new ForbiddenException('Forbidden');
      await this.promosService.assertEventBelongsToOrganization(
        promo.event_id,
        this.orgId(user),
      );
      return;
    }
    if (promo.venue_id !== this.venueId(user))
      throw new ForbiddenException('Forbidden');
  }
}
