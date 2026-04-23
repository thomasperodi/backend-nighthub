import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { RequestUser } from '../auth/types';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { CreatePaymentSheetIntentDto } from './dto/create-payment-sheet-intent.dto';
import { PaymentsService } from './payments.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get('venue/transactions')
  @Roles('venue', 'admin')
  listVenueTransactions(
    @CurrentUser() user: RequestUser,
    @Query('limit') limit?: string,
    @Query('venue_id') venueIdQuery?: string,
  ) {
    const parsedLimit = limit ? parseInt(limit, 10) : undefined;

    if (user.role === 'admin') {
      return this.paymentsService.listVenueTransactions({
        venueId: venueIdQuery,
        limit: parsedLimit,
      });
    }

    if (!user.venue_id) {
      throw new ForbiddenException('Missing venue_id for this user');
    }

    return this.paymentsService.listVenueTransactions({
      venueId: user.venue_id,
      limit: parsedLimit,
    });
  }

  @Post('venue/orders/:id/refund')
  @Roles('venue', 'admin')
  refundVenueOrder(
    @CurrentUser() user: RequestUser,
    @Param('id') orderId: string,
    @Body()
    body?: {
      reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
      venue_id?: string;
    },
  ) {
    const venueId =
      user.role === 'admin' ? body?.venue_id ?? undefined : user.venue_id;

    if (!venueId) {
      throw new ForbiddenException('Missing venue_id for this user');
    }

    return this.paymentsService.refundVenueOrder({
      venueId,
      orderId,
      reason: body?.reason,
    });
  }

  @Post('venue/orders/refund-bulk')
  @Roles('venue', 'admin')
  refundVenueOrdersBulk(
    @CurrentUser() user: RequestUser,
    @Body()
    body: {
      order_ids?: string[];
      reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
      venue_id?: string;
    },
  ) {
    const venueId =
      user.role === 'admin' ? body?.venue_id ?? undefined : user.venue_id;

    if (!venueId) {
      throw new ForbiddenException('Missing venue_id for this user');
    }

    const orderIds = Array.isArray(body?.order_ids)
      ? body.order_ids.filter((id) => typeof id === 'string' && id.trim().length > 0)
      : [];

    return this.paymentsService.refundVenueOrdersBulk({
      venueId,
      orderIds,
      reason: body?.reason,
    });
  }

  @Post('checkout-session')
  @Roles('client', 'admin')
  createCheckoutSession(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateCheckoutSessionDto,
  ) {
    if (!dto?.event_id) {
      throw new BadRequestException('event_id required');
    }

    return this.paymentsService.createEntryCheckoutSession({
      userId: user.id,
      eventId: dto.event_id,
      quantity: dto.quantity,
      trackingCode: dto.tracking_code ?? dto.ref_code ?? dto.pr_code,
      inviterUserId: dto.inviter_user_id,
    });
  }

  @Get('checkout-session/:id/confirm')
  @Roles('client', 'admin')
  confirmCheckoutSession(
    @CurrentUser() user: RequestUser,
    @Param('id') sessionId: string,
  ) {
    return this.paymentsService.confirmCheckoutSession({
      userId: user.id,
      stripeSessionId: sessionId,
    });
  }

  @Post('payment-sheet-intent')
  @Roles('client', 'admin')
  createPaymentSheetIntent(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreatePaymentSheetIntentDto,
  ) {
    if (!dto?.event_id) {
      throw new BadRequestException('event_id required');
    }

    return this.paymentsService.createEntryPaymentSheetIntent({
      userId: user.id,
      eventId: dto.event_id,
      quantity: dto.quantity,
      trackingCode: dto.tracking_code ?? dto.ref_code ?? dto.pr_code,
      inviterUserId: dto.inviter_user_id,
    });
  }

  @Post('payment-intent/:id/confirm')
  @Roles('client', 'admin')
  confirmPaymentIntent(
    @CurrentUser() user: RequestUser,
    @Param('id') paymentIntentId: string,
  ) {
    return this.paymentsService.confirmPaymentIntent({
      userId: user.id,
      paymentIntentId,
    });
  }
}
