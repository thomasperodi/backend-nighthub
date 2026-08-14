DO $$
BEGIN
  CREATE TYPE "VenueTableBookingPolicy" AS ENUM ('exclusive', 'shared');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "VenueFloorLandmarkType" AS ENUM ('dj_console');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "venue_table_zones" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "venue_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "color" TEXT,
  "per_testa" DECIMAL(10,2),
  "costo_minimo" DECIMAL(10,2),
  "persone_max" INTEGER,
  "booking_policy" "VenueTableBookingPolicy" NOT NULL DEFAULT 'exclusive',
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "venue_table_zones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_table_zones_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "venue_table_zones_venue_id_name_key"
  ON "venue_table_zones" ("venue_id", "name");

CREATE INDEX "venue_table_zones_venue_id_sort_order_idx"
  ON "venue_table_zones" ("venue_id", "sort_order");

CREATE INDEX "venue_table_zones_venue_id_is_active_idx"
  ON "venue_table_zones" ("venue_id", "is_active");

CREATE TABLE "venue_floor_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "venue_id" UUID NOT NULL,
  "background_image" TEXT,
  "canvas_width" DECIMAL(10,2) NOT NULL DEFAULT 1000,
  "canvas_height" DECIMAL(10,2) NOT NULL DEFAULT 700,
  "grid_size" DECIMAL(10,2) NOT NULL DEFAULT 24,
  "show_grid" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "venue_floor_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_floor_plans_venue_id_fkey"
    FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "venue_floor_plans_venue_id_key"
  ON "venue_floor_plans" ("venue_id");

CREATE TABLE "venue_floor_landmarks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "floor_plan_id" UUID NOT NULL,
  "type" "VenueFloorLandmarkType" NOT NULL DEFAULT 'dj_console',
  "label" TEXT,
  "x" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "y" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "width" DECIMAL(10,2) NOT NULL DEFAULT 120,
  "height" DECIMAL(10,2) NOT NULL DEFAULT 48,
  "rotation" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "color" TEXT,
  "metadata" JSONB,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "venue_floor_landmarks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "venue_floor_landmarks_floor_plan_id_fkey"
    FOREIGN KEY ("floor_plan_id") REFERENCES "venue_floor_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "venue_floor_landmarks_floor_plan_id_sort_order_idx"
  ON "venue_floor_landmarks" ("floor_plan_id", "sort_order");

CREATE INDEX "venue_floor_landmarks_floor_plan_id_type_idx"
  ON "venue_floor_landmarks" ("floor_plan_id", "type");

ALTER TABLE "venue_tables"
  ADD COLUMN "venue_table_zone_id" UUID,
  ADD COLUMN "floor_x" DECIMAL(10,2),
  ADD COLUMN "floor_y" DECIMAL(10,2),
  ADD COLUMN "floor_w" DECIMAL(10,2),
  ADD COLUMN "floor_h" DECIMAL(10,2),
  ADD COLUMN "floor_shape" TEXT DEFAULT 'rectangle',
  ADD COLUMN "floor_rotation" DECIMAL(10,2),
  ADD COLUMN "layout_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "is_hidden" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "venue_tables"
  ADD CONSTRAINT "venue_tables_venue_table_zone_id_fkey"
  FOREIGN KEY ("venue_table_zone_id") REFERENCES "venue_table_zones"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "venue_tables_venue_id_venue_table_zone_id_idx"
  ON "venue_tables" ("venue_id", "venue_table_zone_id");

CREATE INDEX "venue_tables_venue_id_layout_order_idx"
  ON "venue_tables" ("venue_id", "layout_order");

CREATE INDEX "venue_tables_venue_id_floor_x_floor_y_idx"
  ON "venue_tables" ("venue_id", "floor_x", "floor_y");

WITH ranked_active_tables AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "event_id", "venue_table_id"
      ORDER BY "created_at" DESC, id DESC
    ) AS row_num
  FROM "reservations"
  WHERE
    "type" = 'table'::"ReservationType"
    AND "venue_table_id" IS NOT NULL
    AND "status" <> 'cancelled'::"ReservationStatus"
)
UPDATE "reservations" r
SET "status" = 'cancelled'::"ReservationStatus"
FROM ranked_active_tables rat
WHERE r.id = rat.id
  AND rat.row_num > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "reservations_unique_active_table_event_idx"
  ON "reservations" ("event_id", "venue_table_id")
  WHERE "type" = 'table' AND "status" <> 'cancelled' AND "venue_table_id" IS NOT NULL;

WITH ranked_zones AS (
  SELECT
    vt."venue_id",
    COALESCE(NULLIF(BTRIM(vt."zona"), ''), NULLIF(BTRIM(vt."nome"), ''), 'Senza zona') AS zone_name,
    vt."per_testa",
    vt."costo_minimo",
    vt."persone_max",
    ROW_NUMBER() OVER (
      PARTITION BY vt."venue_id", LOWER(COALESCE(NULLIF(BTRIM(vt."zona"), ''), NULLIF(BTRIM(vt."nome"), ''), 'Senza zona'))
      ORDER BY
        (
          CASE WHEN vt."per_testa" IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN vt."costo_minimo" IS NOT NULL THEN 1 ELSE 0 END +
          CASE WHEN vt."persone_max" IS NOT NULL THEN 1 ELSE 0 END
        ) DESC,
        COALESCE(vt."numero", 2147483647),
        vt."id"
    ) AS zone_rank,
    ROW_NUMBER() OVER (
      PARTITION BY vt."venue_id"
      ORDER BY LOWER(COALESCE(NULLIF(BTRIM(vt."zona"), ''), NULLIF(BTRIM(vt."nome"), ''), 'Senza zona')),
        COALESCE(vt."numero", 2147483647),
        vt."id"
    ) AS venue_sort_order
  FROM "venue_tables" vt
)
INSERT INTO "venue_table_zones" (
  "id",
  "venue_id",
  "name",
  "per_testa",
  "costo_minimo",
  "persone_max",
  "booking_policy",
  "sort_order",
  "is_active",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  rz."venue_id",
  rz.zone_name,
  rz."per_testa",
  rz."costo_minimo",
  rz."persone_max",
  'exclusive'::"VenueTableBookingPolicy",
  GREATEST(rz.venue_sort_order - 1, 0),
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM ranked_zones rz
WHERE rz.zone_rank = 1;

UPDATE "venue_tables" vt
SET
  "venue_table_zone_id" = z."id",
  "floor_w" = COALESCE(vt."floor_w", 92),
  "floor_h" = COALESCE(vt."floor_h", 56),
  "layout_order" = CASE
    WHEN vt."numero" IS NOT NULL THEN vt."numero"
    ELSE vt."layout_order"
  END
FROM "venue_table_zones" z
WHERE z."venue_id" = vt."venue_id"
  AND LOWER(z."name") = LOWER(COALESCE(NULLIF(BTRIM(vt."zona"), ''), NULLIF(BTRIM(vt."nome"), ''), 'Senza zona'));

INSERT INTO "venue_floor_plans" (
  "id",
  "venue_id",
  "canvas_width",
  "canvas_height",
  "grid_size",
  "show_grid",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  v."id",
  1000,
  700,
  24,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "venues" v
ON CONFLICT ("venue_id") DO NOTHING;

WITH numbered_tables AS (
  SELECT
    vt."id",
    ROW_NUMBER() OVER (
      PARTITION BY vt."venue_id"
      ORDER BY vt."layout_order", COALESCE(vt."numero", 2147483647), vt."id"
    ) - 1 AS row_index
  FROM "venue_tables" vt
)
UPDATE "venue_tables" vt
SET
  "floor_x" = COALESCE(vt."floor_x", 64 + ((nt.row_index % 4) * 120)),
  "floor_y" = COALESCE(vt."floor_y", 96 + (FLOOR(nt.row_index / 4.0) * 92))
FROM numbered_tables nt
WHERE nt."id" = vt."id";