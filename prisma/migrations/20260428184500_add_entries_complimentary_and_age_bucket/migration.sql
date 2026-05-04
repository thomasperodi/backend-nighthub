DO $$
BEGIN
  CREATE TYPE "AgeBucket" AS ENUM (
    'AGE_18_20',
    'AGE_21_24',
    'AGE_25_29',
    'AGE_30_34',
    'AGE_35_PLUS',
    'UNKNOWN'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "entries"
  ADD COLUMN "is_complimentary" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "age_bucket" "AgeBucket";

CREATE INDEX IF NOT EXISTS "entries_event_id_age_bucket_created_at_idx"
  ON "entries" ("event_id", "age_bucket", "created_at");
