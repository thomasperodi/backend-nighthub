import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventAccessMode, Prisma, ReservationStatus, ReservationType, TicketOrderStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
  ) {}

  private getStripeClient(): Stripe {
    const secret = (process.env.STRIPE_SECRET_KEY || '').trim();
    if (!secret) {
      throw new BadRequestException('Stripe is not configured (missing STRIPE_SECRET_KEY)');
    }
    return new Stripe(secret, { apiVersion: '2025-02-24.acacia' });
  }
  // ---------- STRIPE FEE CONFIG ----------
private readonly STRIPE_PERCENT = 0.029;
private readonly STRIPE_FIXED_EUR = 0.25;
//private readonly PLATFORM_MARGIN_EUR = 0.10;
private readonly SAFETY_BUFFER_CENTS = 4;

private calcGrossCentsFromNet(netEuro: number): number {
  const gross = (netEuro + this.STRIPE_FIXED_EUR) / (1 - this.STRIPE_PERCENT);
  return Math.ceil(gross * 100) + this.SAFETY_BUFFER_CENTS;
}


  private parseQuantity(value?: number): number {
    const quantity = value ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw new BadRequestException('quantity must be an integer between 1 and 10');
    }
    return quantity;
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
      throw new BadRequestException('Hai già una prenotazione per questa serata');
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
    const currency = (event.presale_currency || 'eur').toLowerCase();
    const amountTotal = new Prisma.Decimal(unitPrice).mul(quantity);

    const baseReturnUrl =
      process.env.STRIPE_CHECKOUT_RETURN_URL ||
      process.env.FRONTEND_APP_URL ||
      'https://example.com';

    const successUrl = `${baseReturnUrl}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseReturnUrl}?checkout=cancel`;
    const grossUnitCents = this.calcGrossCentsFromNet(unitPrice);

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        success_url: successUrl,
        cancel_url: cancelUrl,
        line_items: [
          {
            quantity,
            price_data: {
              currency,
              unit_amount: grossUnitCents,
              product_data: {
                name: `${event.name} · Ingresso prevendita`,
              },
            },
          },
        ],
        metadata: {
          app: 'NightHub',
          type: 'entry_presale',
          user_id: params.userId,
          event_id: params.eventId,
          venue_id: event.venue_id,
          quantity: String(quantity),
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
      throw new BadRequestException('Hai già una prenotazione per questa serata');
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
    const currency = (event.presale_currency || 'eur').toLowerCase();
    const netTotal = unitPrice * quantity;
    const amountInCents = this.calcGrossCentsFromNet(netTotal);
    const amountTotal = new Prisma.Decimal(unitPrice).mul(quantity);



     const paymentIntent = await stripe.paymentIntents.create(
    {
      amount: amountInCents,
      currency,
      automatic_payment_methods: { enabled: true },
       transfer_data: {
      destination: venueStripeAccountId, // il locale riceve il netto
    },
    application_fee_amount: 0,
      metadata: {
        app: 'NightHub',
        type: 'entry_presale',
        user_id: params.userId,
        event_id: params.eventId,
        venue_id: event.venue_id,
        quantity: String(quantity),
      },
    },
    {
      stripeAccount: venueStripeAccountId, // ✅ Direct charge
    }
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
      amount_total: Number(amountTotal),
      currency,
      quantity,
    };
  }

  async confirmPaymentIntent(params: { userId: string; paymentIntentId: string }) {
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
      const reservation = await this.reservationsService.getReservation(order.reservation_id);
      return {
        paid: true,
        reservation,
        order_status: order.status,
      };
    }

    const stripe = this.getStripeClient();
    const paymentIntent = await stripe.paymentIntents.retrieve(
  params.paymentIntentId,
  { stripeAccount: order.stripe_account_id }
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

    const reservation = await this.prisma.$transaction(async (tx) => {
      const currentOrder = await tx.ticket_orders.findUnique({ where: { id: order.id } });
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
        throw new BadRequestException('Event is not available for pre-sale anymore');
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
      reservation: await this.reservationsService.getReservation(reservation.id),
    };
  }

  async confirmCheckoutSession(params: { userId: string; stripeSessionId: string }) {
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
    if (order.user_id !== params.userId) throw new NotFoundException('Checkout session not found');

    if (order.status === TicketOrderStatus.paid && order.reservation_id) {
      const reservation = await this.reservationsService.getReservation(order.reservation_id);
      return {
        paid: true,
        reservation,
        order_status: order.status,
      };
    }

    const stripe = this.getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(
      params.stripeSessionId,
      {
        stripeAccount: order.stripe_account_id,
      },
    );

    const paymentStatus = session.payment_status;
    if (paymentStatus !== 'paid') {
      const status = paymentStatus === 'unpaid' ? TicketOrderStatus.created : TicketOrderStatus.failed;
      await this.prisma.ticket_orders.update({
        where: { id: order.id },
        data: {
          status,
          stripe_payment_intent:
            typeof session.payment_intent === 'string' ? session.payment_intent : null,
        },
      });

      return {
        paid: false,
        order_status: status,
      };
    }

    const reservation = await this.prisma.$transaction(async (tx) => {
      const currentOrder = await tx.ticket_orders.findUnique({ where: { id: order.id } });
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
        throw new BadRequestException('Event is not available for pre-sale anymore');
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
      reservation: await this.reservationsService.getReservation(reservation.id),
    };
  }
}
