import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EventAccessMode,
  ReservationStatus,
  ReservationType,
  TicketOrderStatus,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';

function calculateTotalAmount({
  ticketPriceCents,
  platformFeeCents,
  stripePercentage,
  stripeFixedCents,
}: {
  ticketPriceCents: number;
  platformFeeCents: number;
  stripePercentage: number;
  stripeFixedCents: number;
}) {
  return Math.ceil(
    (ticketPriceCents + platformFeeCents + stripeFixedCents) /
      (1 - stripePercentage),
  );
}

function estimateStripeFeeCents({
  amountCents,
  stripePercentage,
  stripeFixedCents,
}: {
  amountCents: number;
  stripePercentage: number;
  stripeFixedCents: number;
}) {
  return Math.ceil(amountCents * stripePercentage) + stripeFixedCents;
}

@Injectable()
export class PaymentsService {
  private platformStripeAccountId?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
  ) {}

  private getStripeClient(): Stripe {
    const secret = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!secret) {
      throw new BadRequestException(
        'Stripe is not configured (missing STRIPE_SECRET_KEY)',
      );
    }
    return new Stripe(secret, { apiVersion: '2025-02-24.acacia' });
  }

  private readonly STRIPE_PERCENTAGE = 0.0525;
  private readonly STRIPE_FIXED_CENTS = 25;
  private readonly PLATFORM_FEE_CENTS = 0;

  private toRefundReason(
    reason?: string,
  ): Stripe.RefundCreateParams.Reason | undefined {
    if (reason === 'duplicate') return 'duplicate';
    if (reason === 'fraudulent') return 'fraudulent';
    if (reason === 'requested_by_customer') return 'requested_by_customer';
    return undefined;
  }

  private parseQuantity(value?: number): number {
    const quantity = value ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw new BadRequestException(
        'quantity must be an integer between 1 and 10',
      );
    }
    return quantity;
  }

  private toCents(value: unknown): number {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.round(value));
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.round(parsed));
    }

    return 0;
  }

  private toMoney(cents: number): number {
    return Number((cents / 100).toFixed(2));
  }

  private async resolveTicketAmountCentsForOrder(params: {
    stripe: Stripe;
    orderId: string;
    stripeAccountId: string;
    paymentIntentId: string;
    stripeSessionId: string;
    eventId: string;
    quantity: number;
    orderTotalCents: number;
  }): Promise<number> {
    const paymentIntent = await params.stripe.paymentIntents.retrieve(
      params.paymentIntentId,
      {},
      { stripeAccount: params.stripeAccountId },
    );

    const fromPaymentIntent = this.toCents(
      paymentIntent.metadata?.ticket_price_cents,
    );
    if (fromPaymentIntent > 0) {
      return Math.min(fromPaymentIntent, params.orderTotalCents);
    }

    const isCheckoutSession = params.stripeSessionId.startsWith('cs_');
    if (isCheckoutSession) {
      try {
        const session = await params.stripe.checkout.sessions.retrieve(
          params.stripeSessionId,
          {},
          { stripeAccount: params.stripeAccountId },
        );

        const fromSession = this.toCents(session.metadata?.ticket_price_cents);
        if (fromSession > 0) {
          return Math.min(fromSession, params.orderTotalCents);
        }
      } catch {
        // ignore and use fallback
      }
    }

    const fallbackTicket = await this.resolveTicketPriceCents({
      eventId: params.eventId,
      quantity: params.quantity,
    });

    return Math.min(fallbackTicket, params.orderTotalCents);
  }

  private async resolveTicketRefundedCents(params: {
    stripe: Stripe;
    stripeAccountId: string;
    paymentIntentId: string;
  }): Promise<number> {
    const refunds = await params.stripe.refunds.list(
      {
        payment_intent: params.paymentIntentId,
        limit: 100,
      },
      {
        stripeAccount: params.stripeAccountId,
      },
    );

    return refunds.data
      .filter((r) => r.status !== 'failed' && r.status !== 'canceled')
      .filter((r) => (r.metadata?.scope || '') === 'ticket_only')
      .reduce((sum, r) => sum + (r.amount ?? 0), 0);
  }

  private async getPlatformStripeAccountId(stripe: Stripe): Promise<string> {
    if (this.platformStripeAccountId) {
      return this.platformStripeAccountId;
    }

    const account = await stripe.accounts.retrieve();
    this.platformStripeAccountId = account.id;
    return account.id;
  }

  private async resolveTicketPriceCents(params: {
    eventId: string;
    quantity: number;
  }): Promise<number> {
    const event = await this.prisma.events.findUnique({
      where: { id: params.eventId },
      select: { presale_price: true },
    });

    const unitPrice = event?.presale_price ? Number(event.presale_price) : 0;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new BadRequestException('Invalid presale price for this event');
    }

    return Math.round(unitPrice * params.quantity * 100);
  }

  private async settlePlatformCommissionRemainder(params: {
    stripe: Stripe;
    orderId: string;
    paymentIntent: Stripe.PaymentIntent;
    connectedAccountId: string;
    eventId: string;
    quantity: number;
    currency: string;
  }): Promise<void> {
    const latestChargeId =
      typeof params.paymentIntent.latest_charge === 'string'
        ? params.paymentIntent.latest_charge
        : null;

    if (!latestChargeId) {
      return;
    }

    const charge = await params.stripe.charges.retrieve(
      latestChargeId,
      {
        expand: ['balance_transaction'],
      },
      {
        stripeAccount: params.connectedAccountId,
      },
    );

    const balanceTransaction =
      typeof charge.balance_transaction === 'string'
        ? null
        : charge.balance_transaction;

    const effectiveStripeFeeCents = balanceTransaction?.fee ?? 0;
    const ticketPriceCents = await this.resolveTicketPriceCents({
      eventId: params.eventId,
      quantity: params.quantity,
    });

    const amountCents = params.paymentIntent.amount;
    const targetPlatformCommissionCents = Math.max(
      amountCents - effectiveStripeFeeCents - ticketPriceCents,
      0,
    );
    const alreadyAppliedCents =
      params.paymentIntent.application_fee_amount ?? 0;
    const remainderCents = Math.max(
      targetPlatformCommissionCents - alreadyAppliedCents,
      0,
    );

    if (remainderCents <= 0) {
      return;
    }

    const platformAccountId = await this.getPlatformStripeAccountId(
      params.stripe,
    );

    await params.stripe.transfers.create(
      {
        amount: remainderCents,
        currency: params.currency.toLowerCase(),
        destination: platformAccountId,
        metadata: {
          app: 'NightHub',
          type: 'platform_commission_remainder',
          order_id: params.orderId,
          payment_intent_id: params.paymentIntent.id,
        },
      },
      {
        stripeAccount: params.connectedAccountId,
        idempotencyKey: `order_${params.orderId}_platform_remainder_${params.paymentIntent.id}`,
      },
    );
  }

  private async assertSupportedConnectedAccount(
    stripe: Stripe,
    connectedAccountId: string,
  ): Promise<void> {
    const account = await stripe.accounts.retrieve(connectedAccountId);
    if ('deleted' in account && account.deleted) {
      throw new BadRequestException(
        'Account Stripe Connect del locale non valido',
      );
    }

    const accountType = account.type ?? null;
    if (accountType !== 'express' && accountType !== 'standard') {
      throw new BadRequestException(
        'Il conto Stripe Connect del locale deve essere Express o Standard',
      );
    }

    if (!account.charges_enabled) {
      throw new BadRequestException(
        'Account Stripe del locale non ancora abilitato ai pagamenti',
      );
    }
  }

  async listVenueTransactions(params: { venueId?: string; limit?: number }) {
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));

    const where = params.venueId
      ? { event: { venue_id: params.venueId } }
      : undefined;

    const orders = await this.prisma.ticket_orders.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true,
        user_id: true,
        event_id: true,
        reservation_id: true,
        status: true,
        quantity: true,
        amount_total: true,
        currency: true,
        stripe_account_id: true,
        stripe_payment_intent: true,
        stripe_session_id: true,
        paid_at: true,
        created_at: true,
        event: {
          select: {
            id: true,
            venue_id: true,
            name: true,
            date: true,
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    const stripe = this.getStripeClient();

    const rows = await Promise.all(
      orders.map(async (order) => {
        if (!order.stripe_payment_intent) {
          return {
            ...order,
            amount_total: Number(order.amount_total),
            refunded_amount: 0,
            refunded_currency: order.currency,
            refunded_status: 'none' as const,
          };
        }

        try {
          const orderTotalCents = Math.round(Number(order.amount_total) * 100);
          const ticketAmountCents = await this.resolveTicketAmountCentsForOrder(
            {
              stripe,
              orderId: order.id,
              stripeAccountId: order.stripe_account_id,
              paymentIntentId: order.stripe_payment_intent,
              stripeSessionId: order.stripe_session_id,
              eventId: order.event_id,
              quantity: order.quantity,
              orderTotalCents,
            },
          );

          const refundedCents = await this.resolveTicketRefundedCents({
            stripe,
            stripeAccountId: order.stripe_account_id,
            paymentIntentId: order.stripe_payment_intent,
          });

          const refundableRemainingCents = Math.max(
            ticketAmountCents - refundedCents,
            0,
          );

          let refundedStatus: 'none' | 'partial' | 'full' = 'none';
          if (refundedCents > 0 && refundedCents < ticketAmountCents) {
            refundedStatus = 'partial';
          } else if (
            refundedCents >= ticketAmountCents &&
            ticketAmountCents > 0
          ) {
            refundedStatus = 'full';
          }

          return {
            ...order,
            amount_total: Number(order.amount_total),
            ticket_amount: this.toMoney(ticketAmountCents),
            refundable_remaining: this.toMoney(refundableRemainingCents),
            refunded_amount: this.toMoney(refundedCents),
            refunded_currency: order.currency,
            refunded_status: refundedStatus,
          };
        } catch {
          return {
            ...order,
            amount_total: Number(order.amount_total),
            ticket_amount: 0,
            refundable_remaining: 0,
            refunded_amount: 0,
            refunded_currency: order.currency,
            refunded_status: 'none' as const,
          };
        }
      }),
    );

    return rows;
  }

  async refundVenueOrder(params: {
    venueId: string;
    orderId: string;
    reason?: string;
  }) {
    const order = await this.prisma.ticket_orders.findUnique({
      where: { id: params.orderId },
      select: {
        id: true,
        event_id: true,
        reservation_id: true,
        stripe_account_id: true,
        stripe_payment_intent: true,
        stripe_session_id: true,
        amount_total: true,
        currency: true,
        quantity: true,
        status: true,
        event: {
          select: {
            id: true,
            venue_id: true,
            access_mode: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.event.venue_id !== params.venueId) {
      throw new ForbiddenException('Forbidden');
    }

    if (order.status !== TicketOrderStatus.paid) {
      throw new BadRequestException('Only paid orders can be refunded');
    }

    if (!order.stripe_payment_intent) {
      throw new BadRequestException('Missing stripe payment intent on order');
    }

    const orderTotalCents = Math.round(Number(order.amount_total) * 100);
    if (orderTotalCents <= 0) {
      throw new BadRequestException('Invalid order amount');
    }

    const stripe = this.getStripeClient();
    const ticketAmountCents = await this.resolveTicketAmountCentsForOrder({
      stripe,
      orderId: order.id,
      stripeAccountId: order.stripe_account_id,
      paymentIntentId: order.stripe_payment_intent,
      stripeSessionId: order.stripe_session_id,
      eventId: order.event_id,
      quantity: order.quantity,
      orderTotalCents,
    });

    const refundedTicketCents = await this.resolveTicketRefundedCents({
      stripe,
      stripeAccountId: order.stripe_account_id,
      paymentIntentId: order.stripe_payment_intent,
    });

    const amountCents = Math.max(ticketAmountCents - refundedTicketCents, 0);
    if (amountCents <= 0) {
      return {
        order_id: order.id,
        refund_id: null,
        refund_status: 'skipped',
        refunded_amount: 0,
        currency: order.currency,
        full_refund: refundedTicketCents >= ticketAmountCents,
        ticket_amount: this.toMoney(ticketAmountCents),
        refundable_remaining: 0,
        policy: 'ticket_only',
      };
    }

    const refund = await stripe.refunds.create(
      {
        payment_intent: order.stripe_payment_intent,
        amount: amountCents,
        reason: this.toRefundReason(params.reason),
        refund_application_fee: false,
        reverse_transfer: false,
        metadata: {
          app: 'NightHub',
          type: 'venue_refund',
          order_id: order.id,
          event_id: order.event_id,
          scope: 'ticket_only',
        },
      },
      {
        stripeAccount: order.stripe_account_id,
        idempotencyKey: `refund_order_${order.id}_ticket_only_${amountCents}`,
      },
    );

    const finalRefundedTicketCents = refundedTicketCents + amountCents;
    const isFullRefund = finalRefundedTicketCents >= ticketAmountCents;

    if (isFullRefund && refund.status === 'succeeded') {
      await this.prisma.$transaction(async (tx) => {
        await tx.ticket_orders.update({
          where: { id: order.id },
          data: {
            status: TicketOrderStatus.cancelled,
          },
        });

        if (order.reservation_id) {
          await tx.reservations.update({
            where: { id: order.reservation_id },
            data: { status: ReservationStatus.cancelled },
          });
        }

        if (order.event.access_mode === EventAccessMode.PRE_SALE) {
          await tx.events.updateMany({
            where: {
              id: order.event_id,
              presale_sold: { gte: order.quantity },
            },
            data: {
              presale_sold: { decrement: order.quantity },
            },
          });
        }
      });
    }

    return {
      order_id: order.id,
      refund_id: refund.id,
      refund_status: refund.status,
      refunded_amount: this.toMoney(amountCents),
      currency: order.currency,
      full_refund: isFullRefund,
      ticket_amount: this.toMoney(ticketAmountCents),
      refundable_remaining: this.toMoney(
        Math.max(ticketAmountCents - finalRefundedTicketCents, 0),
      ),
      policy: 'ticket_only',
    };
  }

  async refundVenueOrdersBulk(params: {
    venueId: string;
    orderIds: string[];
    reason?: string;
  }) {
    if (!Array.isArray(params.orderIds) || params.orderIds.length === 0) {
      throw new BadRequestException('order_ids required');
    }

    const uniqueOrderIds = Array.from(
      new Set(params.orderIds.map((id) => String(id).trim()).filter(Boolean)),
    );
    if (uniqueOrderIds.length === 0) {
      throw new BadRequestException('order_ids required');
    }

    const settled = await Promise.allSettled(
      uniqueOrderIds.map((orderId) =>
        this.refundVenueOrder({
          venueId: params.venueId,
          orderId,
          reason: params.reason,
        }),
      ),
    );

    const results = settled.map((entry, idx) => {
      const order_id = uniqueOrderIds[idx];
      if (entry.status === 'fulfilled') {
        return {
          ok: true,
          order_id,
          data: entry.value,
        };
      }

      const message =
        entry.reason instanceof Error ? entry.reason.message : 'Refund failed';

      return {
        ok: false,
        order_id,
        error: message,
      };
    });

    return {
      total: results.length,
      success: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      policy: 'ticket_only',
      results,
    };
  }

  async createEntryCheckoutSession(params: {
    userId: string;
    eventId: string;
    quantity?: number;
  }) {
    const quantity = this.parseQuantity(params.quantity);

    const event = await this.prisma.events.findUnique({
      where: { id: params.eventId },
      select: {
        id: true,
        venue_id: true,
        name: true,
        access_mode: true,
        presale_price: true,
        presale_currency: true,
        presale_capacity: true,
        presale_sold: true,
        venue: {
          select: {
            stripe_account_id: true,
            stripe_charges_enabled: true,
            stripe_payouts_enabled: true,
          },
        },
      },
    });

    if (!event) throw new NotFoundException('Event not found');
    if (event.access_mode !== EventAccessMode.PRE_SALE) {
      throw new BadRequestException('This event is not enabled for pre-sale');
    }

    const venueStripeAccountId = event.venue?.stripe_account_id;
    if (!venueStripeAccountId) {
      throw new BadRequestException(
        'Questo locale non ha ancora collegato Stripe Connect',
      );
    }

    if (
      !event.venue?.stripe_charges_enabled ||
      !event.venue?.stripe_payouts_enabled
    ) {
      throw new BadRequestException(
        'Account Stripe del locale non ancora abilitato ai pagamenti',
      );
    }

    const existingActive = await this.prisma.reservations.findFirst({
      where: {
        user_id: params.userId,
        event_id: params.eventId,
        status: { in: ['pending', 'confirmed', 'completed'] },
      },
      select: { id: true },
    });

    if (existingActive) {
      throw new BadRequestException(
        'Hai già una prenotazione per questa serata',
      );
    }

    const unitPrice = event.presale_price ? Number(event.presale_price) : 0;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new BadRequestException('Invalid presale price for this event');
    }

    if (
      event.presale_capacity !== null &&
      event.presale_capacity !== undefined &&
      event.presale_sold + quantity > event.presale_capacity
    ) {
      throw new BadRequestException('Prevendita terminata per questo evento');
    }

    const stripe = this.getStripeClient();
    await this.assertSupportedConnectedAccount(stripe, venueStripeAccountId);
    const currency = (event.presale_currency || 'eur').toLowerCase();

    const baseReturnUrl =
      process.env.STRIPE_CHECKOUT_RETURN_URL ||
      process.env.FRONTEND_APP_URL ||
      'https://example.com';

    const successUrl = `${baseReturnUrl}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseReturnUrl}?checkout=cancel`;
    const ticketPriceCents = Math.round(unitPrice * quantity * 100);
    const platformCommissionCents = this.PLATFORM_FEE_CENTS * quantity;
    const totalAmountCents = calculateTotalAmount({
      ticketPriceCents,
      platformFeeCents: platformCommissionCents,
      stripePercentage: this.STRIPE_PERCENTAGE,
      stripeFixedCents: this.STRIPE_FIXED_CENTS,
    });
    const estimatedStripeFeeCents = estimateStripeFeeCents({
      amountCents: totalAmountCents,
      stripePercentage: this.STRIPE_PERCENTAGE,
      stripeFixedCents: this.STRIPE_FIXED_CENTS,
    });
    const applicationFeeCents = Math.max(
      totalAmountCents - estimatedStripeFeeCents - ticketPriceCents,
      0,
    );
    const serviceFeeCents = applicationFeeCents;
    const amountTotal = totalAmountCents / 100;

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency,
              unit_amount: totalAmountCents,
              product_data: {
                name: `${event.name} · Ingresso prevendita x${quantity}`,
              },
            },
          },
        ],
        payment_intent_data: {
          application_fee_amount: applicationFeeCents,
        },
        metadata: {
          app: 'NightHub',
          type: 'entry_presale',
          user_id: params.userId,
          event_id: params.eventId,
          venue_id: event.venue_id,
          quantity: String(quantity),
          ticket_price_cents: String(ticketPriceCents),
          platform_commission_floor_cents: String(platformCommissionCents),
          stripe_fee_estimate_cents: String(estimatedStripeFeeCents),
          application_fee_cents: String(applicationFeeCents),
          service_fee_cents: String(serviceFeeCents),
          total_amount_cents: String(totalAmountCents),
        },
        client_reference_id: params.userId,
        allow_promotion_codes: true,
      },
      {
        stripeAccount: venueStripeAccountId,
      },
    );

    await this.prisma.ticket_orders.create({
      data: {
        user_id: params.userId,
        event_id: params.eventId,
        stripe_account_id: venueStripeAccountId,
        status: TicketOrderStatus.created,
        quantity,
        amount_total: amountTotal,
        currency,
        stripe_session_id: session.id,
        checkout_url: session.url ?? null,
      },
    });

    return {
      session_id: session.id,
      checkout_url: session.url,
      amount_total: Number(amountTotal),
      ticket_price_total: Number(ticketPriceCents / 100),
      service_fee_total: Number(serviceFeeCents / 100),
      currency,
      quantity,
    };
  }

  async createEntryPaymentSheetIntent(params: {
    userId: string;
    eventId: string;
    quantity?: number;
  }) {
    const quantity = this.parseQuantity(params.quantity);

    const event = await this.prisma.events.findUnique({
      where: { id: params.eventId },
      select: {
        id: true,
        venue_id: true,
        name: true,
        access_mode: true,
        presale_price: true,
        presale_currency: true,
        presale_capacity: true,
        presale_sold: true,
        venue: {
          select: {
            stripe_account_id: true,
            stripe_charges_enabled: true,
            stripe_payouts_enabled: true,
          },
        },
      },
    });

    if (!event) throw new NotFoundException('Event not found');
    if (event.access_mode !== EventAccessMode.PRE_SALE) {
      throw new BadRequestException('This event is not enabled for pre-sale');
    }

    const venueStripeAccountId = event.venue?.stripe_account_id;
    if (!venueStripeAccountId) {
      throw new BadRequestException(
        'Questo locale non ha ancora collegato Stripe Connect',
      );
    }

    if (
      !event.venue?.stripe_charges_enabled ||
      !event.venue?.stripe_payouts_enabled
    ) {
      throw new BadRequestException(
        'Account Stripe del locale non ancora abilitato ai pagamenti',
      );
    }

    const existingActive = await this.prisma.reservations.findFirst({
      where: {
        user_id: params.userId,
        event_id: params.eventId,
        status: { in: ['pending', 'confirmed', 'completed'] },
      },
      select: { id: true },
    });

    if (existingActive) {
      throw new BadRequestException(
        'Hai già una prenotazione per questa serata',
      );
    }

    const unitPrice = event.presale_price ? Number(event.presale_price) : 0;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new BadRequestException('Invalid presale price for this event');
    }

    if (
      event.presale_capacity !== null &&
      event.presale_capacity !== undefined &&
      event.presale_sold + quantity > event.presale_capacity
    ) {
      throw new BadRequestException('Prevendita terminata per questo evento');
    }

    const stripe = this.getStripeClient();
    await this.assertSupportedConnectedAccount(stripe, venueStripeAccountId);
    const currency = (event.presale_currency || 'eur').toLowerCase();
    const ticketPriceCents = Math.round(unitPrice * quantity * 100);
    const platformCommissionCents = this.PLATFORM_FEE_CENTS * quantity;
    const totalAmountCents = calculateTotalAmount({
      ticketPriceCents,
      platformFeeCents: platformCommissionCents,
      stripePercentage: this.STRIPE_PERCENTAGE,
      stripeFixedCents: this.STRIPE_FIXED_CENTS,
    });
    const estimatedStripeFeeCents = estimateStripeFeeCents({
      amountCents: totalAmountCents,
      stripePercentage: this.STRIPE_PERCENTAGE,
      stripeFixedCents: this.STRIPE_FIXED_CENTS,
    });
    const applicationFeeCents = Math.max(
      totalAmountCents - estimatedStripeFeeCents - ticketPriceCents,
      0,
    );
    const serviceFeeCents = applicationFeeCents;
    const amountTotal = totalAmountCents / 100;

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: totalAmountCents,
        currency,
        application_fee_amount: applicationFeeCents,
        automatic_payment_methods: {
          enabled: true,
        },
        metadata: {
          app: 'NightHub',
          type: 'entry_presale',
          user_id: params.userId,
          event_id: params.eventId,
          venue_id: event.venue_id,
          quantity: String(quantity),
          ticket_price_cents: String(ticketPriceCents),
          platform_commission_floor_cents: String(platformCommissionCents),
          stripe_fee_estimate_cents: String(estimatedStripeFeeCents),
          application_fee_cents: String(applicationFeeCents),
          service_fee_cents: String(serviceFeeCents),
          total_amount_cents: String(totalAmountCents),
        },
      },
      {
        stripeAccount: venueStripeAccountId,
      },
    );

    await this.prisma.ticket_orders.create({
      data: {
        user_id: params.userId,
        event_id: params.eventId,
        stripe_account_id: venueStripeAccountId,
        status: TicketOrderStatus.created,
        quantity,
        amount_total: amountTotal,
        currency,
        stripe_session_id: paymentIntent.id,
        stripe_payment_intent: paymentIntent.id,
      },
    });

    return {
      payment_intent_id: paymentIntent.id,
      payment_intent_client_secret: paymentIntent.client_secret,
      stripe_account_id: venueStripeAccountId,
      amount_total: Number(amountTotal),
      ticket_price_total: Number(ticketPriceCents / 100),
      service_fee_total: Number(serviceFeeCents / 100),
      currency,
      quantity,
    };
  }

  async confirmPaymentIntent(params: {
    userId: string;
    paymentIntentId: string;
  }) {
    const order = await this.prisma.ticket_orders.findFirst({
      where: {
        user_id: params.userId,
        OR: [
          { stripe_payment_intent: params.paymentIntentId },
          { stripe_session_id: params.paymentIntentId },
        ],
      },
    });

    if (!order) throw new NotFoundException('Payment intent not found');

    if (order.status === TicketOrderStatus.paid && order.reservation_id) {
      const reservation = await this.reservationsService.getReservation(
        order.reservation_id,
      );
      return {
        paid: true,
        reservation,
        order_status: order.status,
      };
    }

    const stripe = this.getStripeClient();
    if (!order.stripe_account_id) {
      throw new BadRequestException('Missing stripe account id on order');
    }
    const paymentIntent = await stripe.paymentIntents.retrieve(
      params.paymentIntentId,
      {},
      { stripeAccount: order.stripe_account_id },
    );

    if (paymentIntent.status !== 'succeeded') {
      const nextStatus =
        paymentIntent.status === 'canceled'
          ? TicketOrderStatus.cancelled
          : TicketOrderStatus.failed;
      await this.prisma.ticket_orders.update({
        where: { id: order.id },
        data: {
          status: nextStatus,
          stripe_payment_intent: paymentIntent.id,
        },
      });

      return {
        paid: false,
        order_status: nextStatus,
      };
    }

    await this.settlePlatformCommissionRemainder({
      stripe,
      orderId: order.id,
      paymentIntent,
      connectedAccountId: order.stripe_account_id,
      eventId: order.event_id,
      quantity: order.quantity,
      currency: order.currency,
    });

    const reservation = await this.prisma.$transaction(async (tx) => {
      const currentOrder = await tx.ticket_orders.findUnique({
        where: { id: order.id },
      });
      if (!currentOrder) throw new NotFoundException('Ticket order not found');

      if (
        currentOrder.status === TicketOrderStatus.paid &&
        currentOrder.reservation_id
      ) {
        const existing = await tx.reservations.findUnique({
          where: { id: currentOrder.reservation_id },
        });
        if (existing) return existing;
      }

      const activeReservation = await tx.reservations.findFirst({
        where: {
          user_id: params.userId,
          event_id: currentOrder.event_id,
          status: { in: ['pending', 'confirmed', 'completed'] },
        },
      });

      if (activeReservation) {
        await tx.ticket_orders.update({
          where: { id: currentOrder.id },
          data: {
            status: TicketOrderStatus.paid,
            reservation_id: activeReservation.id,
            paid_at: new Date(),
            stripe_payment_intent: paymentIntent.id,
          },
        });
        return activeReservation;
      }

      const event = await tx.events.findUnique({
        where: { id: currentOrder.event_id },
        select: {
          id: true,
          access_mode: true,
          presale_capacity: true,
          presale_sold: true,
        },
      });

      if (!event || event.access_mode !== EventAccessMode.PRE_SALE) {
        throw new BadRequestException(
          'Event is not available for pre-sale anymore',
        );
      }

      if (
        event.presale_capacity !== null &&
        event.presale_capacity !== undefined &&
        event.presale_sold + currentOrder.quantity > event.presale_capacity
      ) {
        throw new BadRequestException('Prevendita terminata per questo evento');
      }

      const qrToken = randomUUID();
      const reservation = await tx.reservations.create({
        data: {
          user_id: params.userId,
          event_id: currentOrder.event_id,
          type: ReservationType.entry,
          status: ReservationStatus.confirmed,
          guests: currentOrder.quantity,
          total_amount: currentOrder.amount_total,
          qr_token: qrToken,
          qr_payload: JSON.stringify({
            v: 1,
            type: 'event_entry',
            reservation_id: '',
            user_id: params.userId,
            event_id: currentOrder.event_id,
            qr_token: qrToken,
            issued_at: new Date().toISOString(),
            source: 'stripe_payment_sheet',
          }),
        },
      });

      const qrPayload = JSON.stringify({
        v: 1,
        type: 'event_entry',
        reservation_id: reservation.id,
        user_id: params.userId,
        event_id: currentOrder.event_id,
        qr_token: qrToken,
        issued_at: new Date().toISOString(),
        source: 'stripe_payment_sheet',
      });

      const reservationWithPayload = await tx.reservations.update({
        where: { id: reservation.id },
        data: { qr_payload: qrPayload },
      });

      await tx.events.update({
        where: { id: currentOrder.event_id },
        data: {
          presale_sold: {
            increment: currentOrder.quantity,
          },
        },
      });

      await tx.ticket_orders.update({
        where: { id: currentOrder.id },
        data: {
          status: TicketOrderStatus.paid,
          reservation_id: reservation.id,
          paid_at: new Date(),
          stripe_payment_intent: paymentIntent.id,
        },
      });

      return reservationWithPayload;
    });

    return {
      paid: true,
      order_status: TicketOrderStatus.paid,
      reservation: await this.reservationsService.getReservation(
        reservation.id,
      ),
    };
  }

  async confirmCheckoutSession(params: {
    userId: string;
    stripeSessionId: string;
  }) {
    const order = await this.prisma.ticket_orders.findUnique({
      where: { stripe_session_id: params.stripeSessionId },
      include: {
        reservation: {
          select: {
            id: true,
            status: true,
            qr_token: true,
            qr_payload: true,
          },
        },
      },
    });

    if (!order) throw new NotFoundException('Checkout session not found');
    if (order.user_id !== params.userId)
      throw new NotFoundException('Checkout session not found');

    if (order.status === TicketOrderStatus.paid && order.reservation_id) {
      const reservation = await this.reservationsService.getReservation(
        order.reservation_id,
      );
      return {
        paid: true,
        reservation,
        order_status: order.status,
      };
    }

    const stripe = this.getStripeClient();
    if (!order.stripe_account_id) {
      throw new BadRequestException('Missing stripe account id on order');
    }
    const session = await stripe.checkout.sessions.retrieve(
      params.stripeSessionId,
      {},
      { stripeAccount: order.stripe_account_id },
    );

    const paymentStatus = session.payment_status;
    if (paymentStatus !== 'paid') {
      const status =
        paymentStatus === 'unpaid'
          ? TicketOrderStatus.created
          : TicketOrderStatus.failed;
      await this.prisma.ticket_orders.update({
        where: { id: order.id },
        data: {
          status,
          stripe_payment_intent:
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : null,
        },
      });

      return {
        paid: false,
        order_status: status,
      };
    }

    const sessionPaymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : null;

    if (sessionPaymentIntentId) {
      const paymentIntent = await stripe.paymentIntents.retrieve(
        sessionPaymentIntentId,
        {},
        { stripeAccount: order.stripe_account_id },
      );

      await this.settlePlatformCommissionRemainder({
        stripe,
        orderId: order.id,
        paymentIntent,
        connectedAccountId: order.stripe_account_id,
        eventId: order.event_id,
        quantity: order.quantity,
        currency: order.currency,
      });
    }

    const reservation = await this.prisma.$transaction(async (tx) => {
      const currentOrder = await tx.ticket_orders.findUnique({
        where: { id: order.id },
      });
      if (!currentOrder) throw new NotFoundException('Ticket order not found');

      if (
        currentOrder.status === TicketOrderStatus.paid &&
        currentOrder.reservation_id
      ) {
        const existing = await tx.reservations.findUnique({
          where: { id: currentOrder.reservation_id },
        });
        if (existing) return existing;
      }

      const activeReservation = await tx.reservations.findFirst({
        where: {
          user_id: params.userId,
          event_id: currentOrder.event_id,
          status: { in: ['pending', 'confirmed', 'completed'] },
        },
      });

      if (activeReservation) {
        await tx.ticket_orders.update({
          where: { id: currentOrder.id },
          data: {
            status: TicketOrderStatus.paid,
            reservation_id: activeReservation.id,
            paid_at: new Date(),
            stripe_payment_intent:
              typeof session.payment_intent === 'string'
                ? session.payment_intent
                : null,
          },
        });
        return activeReservation;
      }

      const event = await tx.events.findUnique({
        where: { id: currentOrder.event_id },
        select: {
          id: true,
          access_mode: true,
          presale_capacity: true,
          presale_sold: true,
        },
      });

      if (!event || event.access_mode !== EventAccessMode.PRE_SALE) {
        throw new BadRequestException(
          'Event is not available for pre-sale anymore',
        );
      }

      if (
        event.presale_capacity !== null &&
        event.presale_capacity !== undefined &&
        event.presale_sold + currentOrder.quantity > event.presale_capacity
      ) {
        throw new BadRequestException('Prevendita terminata per questo evento');
      }

      const qrToken = randomUUID();
      const reservation = await tx.reservations.create({
        data: {
          user_id: params.userId,
          event_id: currentOrder.event_id,
          type: ReservationType.entry,
          status: ReservationStatus.confirmed,
          guests: currentOrder.quantity,
          total_amount: currentOrder.amount_total,
          qr_token: qrToken,
          qr_payload: JSON.stringify({
            v: 1,
            type: 'event_entry',
            reservation_id: '',
            user_id: params.userId,
            event_id: currentOrder.event_id,
            qr_token: qrToken,
            issued_at: new Date().toISOString(),
            source: 'stripe_presale',
          }),
        },
      });

      const qrPayload = JSON.stringify({
        v: 1,
        type: 'event_entry',
        reservation_id: reservation.id,
        user_id: params.userId,
        event_id: currentOrder.event_id,
        qr_token: qrToken,
        issued_at: new Date().toISOString(),
        source: 'stripe_presale',
      });

      const reservationWithPayload = await tx.reservations.update({
        where: { id: reservation.id },
        data: { qr_payload: qrPayload },
      });

      await tx.events.update({
        where: { id: currentOrder.event_id },
        data: {
          presale_sold: {
            increment: currentOrder.quantity,
          },
        },
      });

      await tx.ticket_orders.update({
        where: { id: currentOrder.id },
        data: {
          status: TicketOrderStatus.paid,
          reservation_id: reservation.id,
          paid_at: new Date(),
          stripe_payment_intent:
            typeof session.payment_intent === 'string'
              ? session.payment_intent
              : null,
        },
      });

      return reservationWithPayload;
    });

    return {
      paid: true,
      order_status: TicketOrderStatus.paid,
      reservation: await this.reservationsService.getReservation(
        reservation.id,
      ),
    };
  }
}
