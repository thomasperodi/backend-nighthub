import { ForbiddenException } from '@nestjs/common';

// Shared guard for the handful of `GET .../sync-status`-style endpoints called by an
// external scheduler (Vercel Cron) with a shared secret instead of a user JWT. Mirrors
// the pattern already used by EventsController.assertCronAuth (kept there for its extra
// staff-JWT fallback), extracted here so new maintenance endpoints don't reimplement it.
//
// Vercel Cron Jobs automatically send `Authorization: Bearer <CRON_SECRET>` on every
// invocation when the CRON_SECRET env var is set on the project - see
// https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs. `x-cron-secret`
// and `?token=` are kept as fallbacks for manual/local testing (e.g. curl).
export function assertCronSecret(params: {
  token?: string;
  headerSecret?: string;
  authorization?: string;
}) {
  const expected = process.env.CRON_SECRET || '';
  if (!expected) {
    throw new ForbiddenException('CRON_SECRET is not configured');
  }

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(params.authorization || '');
  const provided =
    params.headerSecret || bearerMatch?.[1] || params.token || '';
  if (!provided || provided !== expected) {
    throw new ForbiddenException('Invalid cron secret');
  }
}
