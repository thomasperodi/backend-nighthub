-- Per-venue negotiated overrides on top of the assigned subscription plan (price/quotas/extra
-- prices). Required for custom-priced plans (Elite, `subscription_plans.is_custom`), which have
-- no default values of their own; optional on regular plans for one-off discounts/exceptions.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "plan_custom_terms" JSONB;
