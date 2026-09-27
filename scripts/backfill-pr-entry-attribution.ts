import 'dotenv/config';

import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Backfill of entries.pr_membership_id for guests who booked through a PR link before the
 * check-in started copying reservations.meta.pr_membership_id onto the entries it creates.
 *
 * Idempotent: only touches entries whose pr_membership_id is still NULL, so it can be re-run.
 *
 * Match rule: same user_id + event_id as a checked-in, non-cancelled `entry` reservation
 * carrying a valid meta.pr_membership_id of an existing membership, method = QR, and created
 * within 2 minutes of that reservation's check-in (the check-in writes all the group's
 * entries in one transaction). The time window keeps unrelated QR entries of the same user
 * at the same event (e.g. a manual door entry recorded by staff) from being attributed.
 *
 *   npx ts-node scripts/backfill-pr-entry-attribution.ts           # dry run: counts only
 *   npx ts-node scripts/backfill-pr-entry-attribution.ts --apply   # writes
 */

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const candidatesSql = Prisma.sql`
  SELECT DISTINCT ON (e.id)
    e.id AS entry_id,
    m.id AS pr_membership_id
  FROM entries e
  JOIN reservations r
    ON r.user_id = e.user_id
   AND r.event_id = e.event_id
  JOIN venue_pr_memberships m
    ON m.id::text = r.meta->>'pr_membership_id'
  WHERE e.pr_membership_id IS NULL
    AND e.method = 'QR'
    AND r.type = 'entry'
    AND r.status <> 'cancelled'
    AND r.checked_in_at IS NOT NULL
    AND e.created_at BETWEEN r.checked_in_at - interval '2 minutes'
                         AND r.checked_in_at + interval '2 minutes'
  ORDER BY e.id, r.checked_in_at DESC
`;

async function main() {
  const summary = await prisma.$queryRaw<
    Array<{ entries: number; memberships: number; events: number }>
  >(Prisma.sql`
    SELECT
      COUNT(*)::int AS entries,
      COUNT(DISTINCT c.pr_membership_id)::int AS memberships,
      COUNT(DISTINCT e.event_id)::int AS events
    FROM (${candidatesSql}) c
    JOIN entries e ON e.id = c.entry_id
  `);
  const { entries = 0, memberships = 0, events = 0 } = summary[0] ?? {};

  console.log(
    `Ingressi da attribuire: ${entries} (PR coinvolti: ${memberships}, serate: ${events})`,
  );

  if (!APPLY) {
    console.log(
      'Dry run: nessuna modifica. Rilancia con --apply per scrivere.',
    );
    return;
  }
  if (entries === 0) {
    console.log('Niente da fare.');
    return;
  }

  const updated = await prisma.$executeRaw(Prisma.sql`
    UPDATE entries e
    SET pr_membership_id = c.pr_membership_id
    FROM (${candidatesSql}) c
    WHERE e.id = c.entry_id
      AND e.pr_membership_id IS NULL
  `);
  console.log(`Aggiornati ${updated} ingressi.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
