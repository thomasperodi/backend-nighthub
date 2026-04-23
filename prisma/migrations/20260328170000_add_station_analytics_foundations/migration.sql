-- Additive migration only.
-- No existing tables are dropped and no existing columns are removed.
-- Existing data is preserved; table_sales.event_id is backfilled from event_tables.

-- CreateEnum
CREATE TYPE "VenueStationType" AS ENUM ('entry', 'cloakroom', 'bar', 'table');

-- CreateEnum
CREATE TYPE "PresenceEventType" AS ENUM (
  'enter_venue',
  'exit_venue',
  'checkin',
  'sale',
  'reservation_created',
  'reservation_checked_in'
);

-- CreateEnum
CREATE TYPE "PresenceEventSource" AS ENUM (
  'qr_checkin',
  'manual_checkin',
  'geofence',
  'bar_sale',
  'cloakroom_sale',
  'table_sale',
  'reservation'
);

-- CreateEnum
CREATE TYPE "ForecastType" AS ENUM (
  'attendance',
  'list_conversion',
  'revenue_total',
  'revenue_entry',
  'revenue_bar',
  'revenue_cloakroom',
  'revenue_table'
);

-- CreateTable
CREATE TABLE "venue_stations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "station_type" "VenueStationType" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_stations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_presence_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "user_id" UUID,
    "reservation_id" UUID,
    "entry_id" UUID,
    "station_id" UUID,
    "event_type" "PresenceEventType" NOT NULL,
    "source" "PresenceEventSource" NOT NULL,
    "amount" DECIMAL(10,2),
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_presence_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_analytics_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "snapshot_date" DATE NOT NULL,
    "entries_count" INTEGER NOT NULL DEFAULT 0,
    "unique_attendees" INTEGER NOT NULL DEFAULT 0,
    "reservations_count" INTEGER NOT NULL DEFAULT 0,
    "ticket_orders_count" INTEGER NOT NULL DEFAULT 0,
    "avg_stay_minutes" DECIMAL(10,2),
    "male_count" INTEGER NOT NULL DEFAULT 0,
    "female_count" INTEGER NOT NULL DEFAULT 0,
    "other_gender_count" INTEGER NOT NULL DEFAULT 0,
    "unknown_gender_count" INTEGER NOT NULL DEFAULT 0,
    "age_18_20" INTEGER NOT NULL DEFAULT 0,
    "age_21_24" INTEGER NOT NULL DEFAULT 0,
    "age_25_29" INTEGER NOT NULL DEFAULT 0,
    "age_30_34" INTEGER NOT NULL DEFAULT 0,
    "age_35_plus" INTEGER NOT NULL DEFAULT 0,
    "entry_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bar_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "cloakroom_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "table_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "event_analytics_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_forecasts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "forecast_type" "ForecastType" NOT NULL,
    "model_version" TEXT NOT NULL,
    "predicted_value" DECIMAL(12,2) NOT NULL,
    "lower_bound" DECIMAL(12,2),
    "upper_bound" DECIMAL(12,2),
    "confidence_score" DECIMAL(5,2),
    "features_snapshot" JSONB,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "event_forecasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_copresence_edges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID,
    "user_a_id" UUID NOT NULL,
    "user_b_id" UUID NOT NULL,
    "first_seen_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "same_event_count" INTEGER NOT NULL DEFAULT 0,
    "same_arrival_count" INTEGER NOT NULL DEFAULT 0,
    "same_table_count" INTEGER NOT NULL DEFAULT 0,
    "avg_arrival_gap_seconds" INTEGER,
    "strength_score" DECIMAL(8,2),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_copresence_edges_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "venue_stays"
ADD COLUMN "event_id" UUID;

-- AlterTable
ALTER TABLE "entries"
ADD COLUMN "station_id" UUID;

-- AlterTable
ALTER TABLE "bar_sales"
ADD COLUMN "station_id" UUID,
ADD COLUMN "staff_id" UUID,
ADD COLUMN "metadata" JSONB;

-- AlterTable
ALTER TABLE "cloakroom_sales"
ADD COLUMN "station_id" UUID,
ADD COLUMN "staff_id" UUID,
ADD COLUMN "metadata" JSONB;

-- AlterTable
ALTER TABLE "table_sales"
ADD COLUMN "event_id" UUID,
ADD COLUMN "station_id" UUID,
ADD COLUMN "staff_id" UUID,
ADD COLUMN "metadata" JSONB;

-- Backfill event_id on historical table sales using event_tables relation.
UPDATE "table_sales" ts
SET "event_id" = et."event_id"
FROM "event_tables" et
WHERE ts."event_table_id" = et."id"
  AND ts."event_id" IS NULL;

-- Seed default operational stations for existing venues.
INSERT INTO "venue_stations" ("venue_id", "name", "station_type", "is_active", "sort_order", "created_at", "updated_at")
SELECT v."id", seed."name", seed."station_type"::"VenueStationType", true, seed."sort_order", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "venues" v
CROSS JOIN (
  VALUES
    ('Ingresso', 'entry', 10),
    ('Guardaroba', 'cloakroom', 20),
    ('Bar', 'bar', 30),
    ('Tavoli', 'table', 40)
) AS seed("name", "station_type", "sort_order")
WHERE NOT EXISTS (
  SELECT 1
  FROM "venue_stations" vs
  WHERE vs."venue_id" = v."id"
    AND LOWER(vs."name") = LOWER(seed."name")
);

-- CreateIndex
CREATE UNIQUE INDEX "venue_stations_venue_id_name_key" ON "venue_stations"("venue_id", "name");

-- CreateIndex
CREATE INDEX "venue_stations_venue_id_station_type_is_active_idx" ON "venue_stations"("venue_id", "station_type", "is_active");

-- CreateIndex
CREATE INDEX "venue_stations_venue_id_sort_order_idx" ON "venue_stations"("venue_id", "sort_order");

-- CreateIndex
CREATE INDEX "venue_stays_event_id_entered_at_idx" ON "venue_stays"("event_id", "entered_at");

-- CreateIndex
CREATE INDEX "entries_event_id_station_id_created_at_idx" ON "entries"("event_id", "station_id", "created_at");

-- CreateIndex
CREATE INDEX "entries_station_id_idx" ON "entries"("station_id");

-- CreateIndex
CREATE INDEX "bar_sales_event_id_station_id_created_at_idx" ON "bar_sales"("event_id", "station_id", "created_at");

-- CreateIndex
CREATE INDEX "bar_sales_staff_id_created_at_idx" ON "bar_sales"("staff_id", "created_at");

-- CreateIndex
CREATE INDEX "cloakroom_sales_event_id_station_id_created_at_idx" ON "cloakroom_sales"("event_id", "station_id", "created_at");

-- CreateIndex
CREATE INDEX "cloakroom_sales_staff_id_created_at_idx" ON "cloakroom_sales"("staff_id", "created_at");

-- CreateIndex
CREATE INDEX "table_sales_event_id_created_at_idx" ON "table_sales"("event_id", "created_at");

-- CreateIndex
CREATE INDEX "table_sales_event_id_station_id_created_at_idx" ON "table_sales"("event_id", "station_id", "created_at");

-- CreateIndex
CREATE INDEX "table_sales_staff_id_created_at_idx" ON "table_sales"("staff_id", "created_at");

-- CreateIndex
CREATE INDEX "event_presence_events_event_id_occurred_at_idx" ON "event_presence_events"("event_id", "occurred_at");

-- CreateIndex
CREATE INDEX "event_presence_events_venue_id_occurred_at_idx" ON "event_presence_events"("venue_id", "occurred_at");

-- CreateIndex
CREATE INDEX "event_presence_events_station_id_occurred_at_idx" ON "event_presence_events"("station_id", "occurred_at");

-- CreateIndex
CREATE INDEX "event_presence_events_user_id_occurred_at_idx" ON "event_presence_events"("user_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "event_analytics_snapshots_event_id_snapshot_date_key" ON "event_analytics_snapshots"("event_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "event_analytics_snapshots_venue_id_snapshot_date_idx" ON "event_analytics_snapshots"("venue_id", "snapshot_date");

-- CreateIndex
CREATE INDEX "event_forecasts_event_id_forecast_type_generated_at_idx" ON "event_forecasts"("event_id", "forecast_type", "generated_at");

-- CreateIndex
CREATE INDEX "event_forecasts_venue_id_forecast_type_generated_at_idx" ON "event_forecasts"("venue_id", "forecast_type", "generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_copresence_edges_user_a_id_user_b_id_venue_id_key" ON "user_copresence_edges"("user_a_id", "user_b_id", "venue_id");

-- CreateIndex
CREATE INDEX "user_copresence_edges_venue_id_strength_score_idx" ON "user_copresence_edges"("venue_id", "strength_score");

-- CreateIndex
CREATE INDEX "user_copresence_edges_user_a_id_strength_score_idx" ON "user_copresence_edges"("user_a_id", "strength_score");

-- CreateIndex
CREATE INDEX "user_copresence_edges_user_b_id_strength_score_idx" ON "user_copresence_edges"("user_b_id", "strength_score");

-- AddForeignKey
ALTER TABLE "venue_stations" ADD CONSTRAINT "venue_stations_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;