-- CreateEnum
CREATE TYPE "VenuePrRole" AS ENUM ('responsabile', 'capo_squadra', 'pr');

-- CreateTable
CREATE TABLE "venue_pr_memberships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "venue_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "VenuePrRole" NOT NULL,
    "parent_membership_id" UUID,
    "ref_code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_pr_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "venue_pr_memberships_venue_id_user_id_key" ON "venue_pr_memberships"("venue_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "venue_pr_memberships_venue_id_ref_code_key" ON "venue_pr_memberships"("venue_id", "ref_code");

-- CreateIndex
CREATE INDEX "venue_pr_memberships_venue_id_role_is_active_idx" ON "venue_pr_memberships"("venue_id", "role", "is_active");

-- CreateIndex
CREATE INDEX "venue_pr_memberships_parent_membership_id_idx" ON "venue_pr_memberships"("parent_membership_id");

-- AddForeignKey
ALTER TABLE "venue_pr_memberships"
ADD CONSTRAINT "venue_pr_memberships_venue_id_fkey"
FOREIGN KEY ("venue_id") REFERENCES "venues"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_memberships"
ADD CONSTRAINT "venue_pr_memberships_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_memberships"
ADD CONSTRAINT "venue_pr_memberships_parent_membership_id_fkey"
FOREIGN KEY ("parent_membership_id") REFERENCES "venue_pr_memberships"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_pr_memberships"
ADD CONSTRAINT "venue_pr_memberships_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
