-- NightHub listino: catalog of subscription plans sold to venues, plus the FK
-- assigning each venue to a plan (nullable - existing venues start unassigned).

CREATE TABLE IF NOT EXISTS "subscription_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tagline" TEXT,
  "icon" TEXT,
  "monthly_price" DECIMAL(10,2),
  "included_events" INTEGER,
  "included_people" INTEGER,
  "extra_event_price" DECIMAL(10,2),
  "extra_person_price" DECIMAL(10,4),
  "is_custom" BOOLEAN NOT NULL DEFAULT false,
  "is_recommended" BOOLEAN NOT NULL DEFAULT false,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscription_plans_key_key" ON "subscription_plans" ("key");
CREATE INDEX IF NOT EXISTS "subscription_plans_sort_order_idx" ON "subscription_plans" ("sort_order");

ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "plan_id" UUID;

CREATE INDEX IF NOT EXISTS "venues_plan_id_idx" ON "venues" ("plan_id");

DO $$ BEGIN
  ALTER TABLE "venues"
    ADD CONSTRAINT "venues_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
