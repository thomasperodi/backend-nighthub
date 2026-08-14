-- Badge collection system: catalog of badges + per-user unlock records.

DO $$ BEGIN
  CREATE TYPE "BadgeCategory" AS ENUM (
    'NIGHTLIFE',
    'EXPLORATION',
    'SOCIAL',
    'SQUAD',
    'TABLES_VIP',
    'STREAK',
    'NIGHT_CHALLENGES',
    'SPECIAL_EVENTS',
    'MILESTONE',
    'SECRET'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "BadgeRarity" AS ENUM (
    'COMMON',
    'RARE',
    'EPIC',
    'LEGENDARY',
    'EXCLUSIVE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "badges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "code" TEXT NOT NULL,
  "category" "BadgeCategory" NOT NULL,
  "rarity" "BadgeRarity" NOT NULL,
  "icon" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "criteria" JSONB NOT NULL,
  "is_secret" BOOLEAN NOT NULL DEFAULT false,
  "is_public" BOOLEAN NOT NULL DEFAULT true,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "available_from" TIMESTAMP(3),
  "available_until" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "badges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "badges_code_key" ON "badges" ("code");
CREATE INDEX IF NOT EXISTS "badges_category_sort_order_idx" ON "badges" ("category", "sort_order");
CREATE INDEX IF NOT EXISTS "badges_is_active_idx" ON "badges" ("is_active");

CREATE TABLE IF NOT EXISTS "user_badges" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "badge_id" UUID NOT NULL,
  "progress_value" INTEGER,
  "unlocked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "seen_at" TIMESTAMP(3),

  CONSTRAINT "user_badges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_badges_user_id_badge_id_key" ON "user_badges" ("user_id", "badge_id");
CREATE INDEX IF NOT EXISTS "user_badges_badge_id_idx" ON "user_badges" ("badge_id");
CREATE INDEX IF NOT EXISTS "user_badges_user_id_unlocked_at_idx" ON "user_badges" ("user_id", "unlocked_at");

DO $$ BEGIN
  ALTER TABLE "user_badges"
    ADD CONSTRAINT "user_badges_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "user_badges"
    ADD CONSTRAINT "user_badges_badge_id_fkey"
    FOREIGN KEY ("badge_id") REFERENCES "badges"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
