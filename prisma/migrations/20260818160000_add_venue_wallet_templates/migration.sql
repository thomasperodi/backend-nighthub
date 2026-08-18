-- CreateTable
CREATE TABLE "venue_wallet_templates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "logo_path" TEXT,
    "background_color" TEXT,
    "foreground_color" TEXT,
    "label_color" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_wallet_templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "venue_wallet_templates_venue_id_key" ON "venue_wallet_templates"("venue_id");

-- CreateIndex
CREATE INDEX "venue_wallet_templates_venue_id_idx" ON "venue_wallet_templates"("venue_id");

-- AddForeignKey
ALTER TABLE "venue_wallet_templates"
ADD CONSTRAINT "venue_wallet_templates_venue_id_fkey"
FOREIGN KEY ("venue_id") REFERENCES "venues"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
