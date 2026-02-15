import {
  Body,
  Controller,
  Get,
  Param,
  Post,
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
