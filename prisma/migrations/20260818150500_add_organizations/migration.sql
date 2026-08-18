-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "vat_number" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_venue_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_venue_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_venue_links_organization_id_venue_id_key" ON "organization_venue_links"("organization_id", "venue_id");

-- CreateIndex
CREATE INDEX "organization_venue_links_venue_id_idx" ON "organization_venue_links"("venue_id");

-- AlterTable: users.organization_id
ALTER TABLE "users" ADD COLUMN "organization_id" UUID;

-- CreateIndex
CREATE INDEX "users_organization_id_idx" ON "users"("organization_id");

-- AlterTable: venue_pr_memberships.organization_id
ALTER TABLE "venue_pr_memberships" ADD COLUMN "organization_id" UUID;

-- CreateIndex
CREATE INDEX "venue_pr_memberships_organization_id_is_active_idx" ON "venue_pr_memberships"("organization_id", "is_active");

-- AddForeignKey
ALTER TABLE "organization_venue_links"
ADD CONSTRAINT "organization_venue_links_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_venue_links"
ADD CONSTRAINT "organization_venue_links_venue_id_fkey"
FOREIGN KEY ("venue_id") REFERENCES "venues"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_venue_links"
ADD CONSTRAINT "organization_venue_links_created_by_admin_id_fkey"
FOREIGN KEY ("created_by_admin_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users"
ADD CONSTRAINT "users_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_memberships"
ADD CONSTRAINT "venue_pr_memberships_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
