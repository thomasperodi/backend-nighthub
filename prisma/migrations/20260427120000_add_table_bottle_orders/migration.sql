DO $$
BEGIN
  CREATE TYPE "TableBottleOrderStatus" AS ENUM ('requested', 'preparing', 'delivered');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "table_bottle_orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_table_id" UUID NOT NULL,
  "requested_by_staff_id" UUID,
  "prepared_by_staff_id" UUID,
  "delivered_by_staff_id" UUID,
  "bottle_name" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unit_price" DECIMAL(10,2) NOT NULL,
  "total_price" DECIMAL(10,2) NOT NULL,
  "status" "TableBottleOrderStatus" NOT NULL DEFAULT 'requested',
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "prepared_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "table_bottle_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "table_bottle_orders_event_table_id_fkey" FOREIGN KEY ("event_table_id") REFERENCES "event_tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "table_bottle_orders_requested_by_staff_id_fkey" FOREIGN KEY ("requested_by_staff_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "table_bottle_orders_prepared_by_staff_id_fkey" FOREIGN KEY ("prepared_by_staff_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "table_bottle_orders_delivered_by_staff_id_fkey" FOREIGN KEY ("delivered_by_staff_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "table_bottle_orders_event_table_id_created_at_idx" ON "table_bottle_orders"("event_table_id", "created_at");
CREATE INDEX "table_bottle_orders_status_created_at_idx" ON "table_bottle_orders"("status", "created_at");
CREATE INDEX "table_bottle_orders_requested_by_staff_id_created_at_idx" ON "table_bottle_orders"("requested_by_staff_id", "created_at");
CREATE INDEX "table_bottle_orders_prepared_by_staff_id_created_at_idx" ON "table_bottle_orders"("prepared_by_staff_id", "created_at");
CREATE INDEX "table_bottle_orders_delivered_by_staff_id_created_at_idx" ON "table_bottle_orders"("delivered_by_staff_id", "created_at");