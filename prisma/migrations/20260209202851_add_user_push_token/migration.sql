-- AlterTable
ALTER TABLE "users" ADD COLUMN     "push_token" TEXT,
ADD COLUMN     "push_token_updated_at" TIMESTAMP(3);
