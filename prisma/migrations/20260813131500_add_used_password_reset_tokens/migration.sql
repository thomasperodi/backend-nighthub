-- CreateTable
CREATE TABLE "used_password_reset_tokens" (
    "jti" TEXT NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "used_password_reset_tokens_pkey" PRIMARY KEY ("jti")
);
