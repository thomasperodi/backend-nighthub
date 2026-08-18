-- AlterTable: organizations.plan_id (billing moves to organizations, venues.plan_id is now legacy)
ALTER TABLE "organizations" ADD COLUMN "plan_id" UUID;

-- CreateIndex
CREATE INDEX "organizations_plan_id_idx" ON "organizations"("plan_id");

-- AddForeignKey
ALTER TABLE "organizations"
ADD CONSTRAINT "organizations_plan_id_fkey"
FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
