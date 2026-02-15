-- Event access mode and presale fields
CREATE TYPE "EventAccessMode" AS ENUM ('LIST', 'PRE_SALE');
CREATE TYPE "TicketOrderStatus" AS ENUM ('created', 'paid', 'cancelled', 'failed');

ALTER TABLE "events"
  ADD COLUMN "access_mode" "EventAccessMode" NOT NULL DEFAULT 'LIST',
  ADD COLUMN "presale_price" DECIMAL,
  ADD COLUMN "presale_currency" TEXT NOT NULL DEFAULT 'eur',
  ADD COLUMN "presale_capacity" INTEGER,
  ADD COLUMN "presale_sold" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ticket_orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "reservation_id" UUID,
  "status" "TicketOrderStatus" NOT NULL DEFAULT 'created',
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "amount_total" DECIMAL NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'eur',
  "stripe_session_id" TEXT NOT NULL,
  "stripe_payment_intent" TEXT,
  "checkout_url" TEXT,
  "paid_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ticket_orders_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ticket_orders"
  ADD CONSTRAINT "ticket_orders_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ticket_orders"
  ADD CONSTRAINT "ticket_orders_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ticket_orders"
  ADD CONSTRAINT "ticket_orders_reservation_id_fkey"
  FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ticket_orders_reservation_id_key" ON "ticket_orders"("reservation_id");
CREATE UNIQUE INDEX "ticket_orders_stripe_session_id_key" ON "ticket_orders"("stripe_session_id");
CREATE INDEX "ticket_orders_user_id_created_at_idx" ON "ticket_orders"("user_id", "created_at");
CREATE INDEX "ticket_orders_event_id_created_at_idx" ON "ticket_orders"("event_id", "created_at");
CREATE INDEX "ticket_orders_status_created_at_idx" ON "ticket_orders"("status", "created_at");
