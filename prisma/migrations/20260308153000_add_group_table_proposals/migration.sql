-- CreateEnum
CREATE TYPE "GroupTableProposalStatus" AS ENUM ('voting', 'ready', 'booked', 'cancelled');

-- CreateEnum
CREATE TYPE "GroupTableProposalVote" AS ENUM ('yes', 'no', 'pending');

-- CreateTable
CREATE TABLE "group_table_proposals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "group_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "venue_id" UUID NOT NULL,
    "guests" INTEGER NOT NULL,
    "note" TEXT,
    "status" "GroupTableProposalStatus" NOT NULL DEFAULT 'voting',
    "booked_reservation_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_table_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_table_proposal_votes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "proposal_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "vote" "GroupTableProposalVote" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_table_proposal_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_table_proposals_booked_reservation_id_key" ON "group_table_proposals"("booked_reservation_id");

-- CreateIndex
CREATE INDEX "group_table_proposals_group_id_created_at_idx" ON "group_table_proposals"("group_id", "created_at");

-- CreateIndex
CREATE INDEX "group_table_proposals_created_by_user_id_created_at_idx" ON "group_table_proposals"("created_by_user_id", "created_at");

-- CreateIndex
CREATE INDEX "group_table_proposals_event_id_idx" ON "group_table_proposals"("event_id");

-- CreateIndex
CREATE INDEX "group_table_proposals_venue_id_idx" ON "group_table_proposals"("venue_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_table_proposal_votes_proposal_id_user_id_key" ON "group_table_proposal_votes"("proposal_id", "user_id");

-- CreateIndex
CREATE INDEX "group_table_proposal_votes_user_id_updated_at_idx" ON "group_table_proposal_votes"("user_id", "updated_at");

-- AddForeignKey
ALTER TABLE "group_table_proposals" ADD CONSTRAINT "group_table_proposals_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "friend_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_table_proposals" ADD CONSTRAINT "group_table_proposals_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_table_proposals" ADD CONSTRAINT "group_table_proposals_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_table_proposals" ADD CONSTRAINT "group_table_proposals_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_table_proposals" ADD CONSTRAINT "group_table_proposals_booked_reservation_id_fkey" FOREIGN KEY ("booked_reservation_id") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_table_proposal_votes" ADD CONSTRAINT "group_table_proposal_votes_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "group_table_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_table_proposal_votes" ADD CONSTRAINT "group_table_proposal_votes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
