import {
  BadRequestException,
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

@Injectable()
export class PaymentsService {
  private stripeOwnerAccountId?: string;

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
  // ---------- STRIPE FEE CONFIG ----------
  private readonly STRIPE_PERCENT = 0.029;
  private readonly STRIPE_FIXED_EUR = 0.25;
  private readonly PLATFORM_MARGIN_EUR = 0.1;
  private readonly SAFETY_BUFFER_CENTS = 3;

  private calcGrossCentsFromNet(netEuro: number): number {
    const gross =
      (netEuro + this.STRIPE_FIXED_EUR + this.PLATFORM_MARGIN_EUR) /
      (1 - this.STRIPE_PERCENT);

    return Math.ceil(gross * 100) + this.SAFETY_BUFFER_CENTS;
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

  private parsePositiveCents(value?: string | null): number | null {
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
  }

  private async getStripeOwnerAccountId(
    stripe: Stripe,
  ): Promise<string | null> {
    if (this.stripeOwnerAccountId !== undefined) {
      return this.stripeOwnerAccountId;
    }

    try {
      const account = await stripe.accounts.retrieve();
      const accountId = account?.id ?? null;
      this.stripeOwnerAccountId = accountId ?? '';
      return accountId;
    } catch {
      this.stripeOwnerAccountId = '';
      return null;
    }
  }

  private async assertVenueAccountIsNotStripeOwner(
    stripe: Stripe,
    venueStripeAccountId: string,
  ): Promise<void> {
    const ownerAccountId = await this.getStripeOwnerAccountId(stripe);
    if (ownerAccountId && ownerAccountId === venueStripeAccountId) {
      throw new BadRequestException(
        'Configurazione Stripe non valida: il conto del locale coincide con il conto Stripe usato dal backend. Usa una chiave piattaforma e un account Connect diverso per il locale.',
      );
    }
  }

  private extractExpandableId(
    value: string | { id: string } | null | undefined,
  ): string | null {
    if (!value) return null;
    if (typeof value === 'string') return value;
    return value.id ?? null;
  }

  private async resolveNetTicketCents(params: {
    eventId: string;
    quantity: number;
    metadataNetCents?: string | null;
  }): Promise<number> {
    const fromMetadata = this.parsePositiveCents(params.metadataNetCents);
    if (fromMetadata) return fromMetadata;

    const event = await this.prisma.events.findUnique({
      where: { id: params.eventId },
      select: { presale_price: true },
    });

    const unitPrice = event?.presale_price ? Number(event.presale_price) : 0;
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new BadRequestException('Invalid presale price for this event');
    }

    const cents = Math.round(unitPrice * params.quantity * 100);
    if (cents <= 0) {
      throw new BadRequestException('Invalid net transfer amount');
    }

    return cents;
  }

  private async transferNetTicketToVenue(params: {
    stripe: Stripe;
    orderId: string;
    destinationAccountId: string;
    currency: string;
    netTicketCents: number;
    sourceChargeId?: string | null;
    eventId: string;
    userId: string;
  }): Promise<void> {
    await this.assertVenueAccountIsNotStripeOwner(
      params.stripe,
      params.destinationAccountId,
    );

    const transferData: Stripe.TransferCreateParams = {
      amount: params.netTicketCents,
      currency: params.currency.toLowerCase(),
      destination: params.destinationAccountId,
      metadata: {
        app: 'NightHub',
        type: 'ticket_net_transfer',
        order_id: params.orderId,
        event_id: params.eventId,
        user_id: params.userId,
      },
    };

    if (params.sourceChargeId) {
      transferData.source_transaction = params.sourceChargeId;
    }

    await params.stripe.transfers.create(transferData, {
      idempotencyKey: `ticket_order_${params.orderId}_net_transfer`,
    });
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
    await this.assertVenueAccountIsNotStripeOwner(stripe, venueStripeAccountId);
    const currency = (event.presale_currency || 'eur').toLowerCase();

    const baseReturnUrl =
      process.env.STRIPE_CHECKOUT_RETURN_URL ||
      process.env.FRONTEND_APP_URL ||
      'https://example.com';

    const successUrl = `${baseReturnUrl}?checkout=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseReturnUrl}?checkout=cancel`;
    const grossTotalCents = this.calcGrossCentsFromNet(unitPrice * quantity);
    const grossUnitCents = Math.ceil(grossTotalCents / quantity);
    const amountTotal = grossTotalCents / 100;

    const session = await stripe.checkout.sessions.create({
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
        net_ticket_cents: String(Math.round(unitPrice * quantity * 100)),
      },
      client_reference_id: params.userId,
      allow_promotion_codes: true,
    });

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
    await this.assertVenueAccountIsNotStripeOwner(stripe, venueStripeAccountId);
    const currency = (event.presale_currency || 'eur').toLowerCase();
    const netTotal = unitPrice * quantity; // prezzo totale netto del biglietto
    const grossCents = this.calcGrossCentsFromNet(netTotal); // utente paga prezzo + fee + buffer
    const netCents = Math.round(netTotal * 100); // quello che deve ricevere il locale
    const applicationFee = grossCents - netCents; // eventuali centesimi residui alla piattaforma
    const amountTotal = grossCents / 100;

    const paymentIntent = await stripe.paymentIntents.create({
      amount: grossCents,
      currency,
      payment_method_types: ['card'],
      metadata: {
        app: 'NightHub',
        type: 'entry_presale',
        user_id: params.userId,
        event_id: params.eventId,
        venue_id: event.venue_id,
        quantity: String(quantity),
        net_ticket_cents: String(netCents),
        venue_net_cents: String(netCents),
        platform_fee_cents: String(applicationFee),
      },
    });

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

    const sourceChargeId = this.extractExpandableId(
      paymentIntent.latest_charge as string | { id: string } | null | undefined,
    );

    const netTicketCents = await this.resolveNetTicketCents({
      eventId: order.event_id,
      quantity: order.quantity,
      metadataNetCents:
        paymentIntent.metadata?.net_ticket_cents ??
        paymentIntent.metadata?.venue_net_cents ??
        null,
    });

    await this.transferNetTicketToVenue({
      stripe,
      orderId: order.id,
      destinationAccountId: order.stripe_account_id,
      currency: order.currency,
      netTicketCents,
      sourceChargeId,
      eventId: order.event_id,
      userId: order.user_id,
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
    const session = await stripe.checkout.sessions.retrieve(
      params.stripeSessionId,
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

    let sourceChargeId: string | null = null;
    let paymentIntentNetCents: string | null = null;

    if (sessionPaymentIntentId) {
      const paymentIntent = await stripe.paymentIntents.retrieve(
        sessionPaymentIntentId,
      );
      sourceChargeId = this.extractExpandableId(
        paymentIntent.latest_charge as
          | string
          | { id: string }
          | null
          | undefined,
      );
      paymentIntentNetCents =
        paymentIntent.metadata?.net_ticket_cents ??
        paymentIntent.metadata?.venue_net_cents ??
        null;
    }

    const netTicketCents = await this.resolveNetTicketCents({
      eventId: order.event_id,
      quantity: order.quantity,
      metadataNetCents:
        session.metadata?.net_ticket_cents ?? paymentIntentNetCents,
    });

    await this.transferNetTicketToVenue({
      stripe,
      orderId: order.id,
      destinationAccountId: order.stripe_account_id,
      currency: order.currency,
      netTicketCents,
      sourceChargeId,
      eventId: order.event_id,
      userId: order.user_id,
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
