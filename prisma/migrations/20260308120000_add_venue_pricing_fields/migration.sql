ALTER TABLE "venues"
ADD COLUMN "cloakroom_unit_price" DECIMAL(10,2) NOT NULL DEFAULT 3,
ADD COLUMN "bar_price_list" JSONB;