import 'dotenv/config';

import { createHash } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Demo accounts for App Store review, on a dedicated venue ("NightHub Demo Club") so the
 * reviewer never sees real venues' data. Everything it creates has an id starting with
 * "de30" and is removed by --cleanup, together with whatever the reviewer did with those
 * accounts (lists, friend requests, reports, sessions...).
 *
 *   npx ts-node scripts/demo/apple-review-demo.ts            # create (fails if already there)
 *   npx ts-node scripts/demo/apple-review-demo.ts --cleanup  # remove everything
 *
 * Location test with one phone (no door scan needed):
 *   npx ts-node scripts/demo/apple-review-demo.ts --test-stay 45.05 9.69  # you are here
 *   npx ts-node scripts/demo/apple-review-demo.ts --test-status           # how it went
 *   npx ts-node scripts/demo/apple-review-demo.ts --test-exit             # fake the exit
 *   npx ts-node scripts/demo/apple-review-demo.ts --test-stay 45.05 9.69 --edge  # exit from home
 *   npx ts-node scripts/demo/apple-review-demo.ts --test-leave            # "you left", later
 * --test-stay moves the demo venue to those coordinates, adds an all-day event today and
 * opens a stay for demo.cliente, as the door check-in would. Run --cleanup and create
 * again afterwards to put the venue back. --test-exit sends the exit the geofence would send
 * (POST /venue-stays/checkpoint on the live API as demo.cliente): it checks the server side
 * without walking away, not iOS waking the app.
 * --edge puts the venue 190 m north of you with a 150 m radius: the app's own check still
 * sees you inside (radius + 50 m margin), so it starts the geofence, and iOS - which sees
 * you outside its 150 m region - fires the exit right away (expo-location reports the
 * initial region state). That runs the real geofence path on the phone without moving.
 * --test-leave does the same move later on, for an open stay: --test-stay at home (you are
 * inside), close the app, wait, --test-leave, open the app. The phone only learns the new
 * position of the venue when the app opens, so this is the closest to walking out.
 *
 * Event dates are relative to the day it runs: if the review slips past the upcoming
 * nights, run --cleanup and then create again.
 *
 * Password of every account: NightDemo!2026
 */

const prisma = new PrismaClient();
const CLEANUP = process.argv.includes('--cleanup');
const TEST_STAY = process.argv.indexOf('--test-stay');
const TEST_STATUS = process.argv.includes('--test-status');
const TEST_EXIT = process.argv.includes('--test-exit');
const TEST_LEAVE = process.argv.includes('--test-leave');
const API_URL = 'https://backend-nighthub-788g.vercel.app/api';

const PASSWORD_HASH =
  '$2b$10$XvWI77Br9Dn43jpo9Zam9.vFhJSPDbDD1mXJmH.F2Rge3VOYTe8fy'; // NightDemo!2026

/**
 * Deterministic id: "de30" + md5(kind:n), shaped as a valid v4 UUID (version and variant
 * nibbles fixed) so the API's ParseUUIDPipe accepts it.
 */
function did(kind: string, n = 1): string {
  const md5 = createHash('md5').update(`${kind}:${n}`).digest('hex');
  const variant = '89ab'[parseInt(md5[16], 16) % 4];
  return `de30${md5.slice(4, 8)}-${md5.slice(8, 12)}-4${md5.slice(13, 16)}-${variant}${md5.slice(17, 20)}-${md5.slice(20)}`;
}

const DAY = 86_400_000;
const today = new Date(
  Date.UTC(
    new Date().getFullYear(),
    new Date().getMonth(),
    new Date().getDate(),
  ),
);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
const gender = (female: boolean): 'M' | 'F' => (female ? 'F' : 'M');
/** Time-of-day column value (Prisma maps @db.Time to a Date on 1970-01-01 UTC). */
const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
/** First Saturday at least `minDays` from today. */
function saturdayFrom(minDays: number): Date {
  const d = addDays(today, minDays);
  return addDays(d, (6 - d.getUTCDay() + 7) % 7);
}

const VENUE = did('venue');
const USERS = {
  cliente: did('user', 1),
  locale: did('user', 2),
  pr: did('user', 3),
  staff: did('user', 4),
  amico1: did('user', 11),
  amico2: did('user', 12),
  amico3: did('user', 13),
  amico4: did('user', 14),
};
const FRIENDS = [USERS.amico1, USERS.amico2, USERS.amico3];
const PR_MEMBERSHIP = did('pr');
const PR_CODE = 'DEMOPR1';

async function seed() {
  const existing = await prisma.users.count({
    where: {
      OR: [
        { id: { in: Object.values(USERS) } },
        { email: { startsWith: 'demo.', endsWith: '@example.com' } },
      ],
    },
  });
  if (existing || (await prisma.venues.findUnique({ where: { id: VENUE } }))) {
    throw new Error('Demo data already present: run with --cleanup first.');
  }

  // Upcoming nights start at least a week out, so they are still upcoming during review.
  const sat1 = saturdayFrom(7);
  const events = [
    {
      n: 1,
      date: addDays(saturdayFrom(1), -14),
      name: 'Saturday Club Night',
      start: '23:00',
      end: '05:00',
      status: 'CLOSED',
    },
    {
      n: 2,
      date: addDays(saturdayFrom(1), -7),
      name: 'Throwback Party',
      start: '23:00',
      end: '05:00',
      status: 'CLOSED',
    },
    {
      n: 3,
      date: sat1,
      name: 'House Night',
      start: '23:00',
      end: '05:00',
      status: 'DRAFT',
    },
    {
      n: 4,
      date: addDays(sat1, 6),
      name: 'Reggaeton Friday',
      start: '23:30',
      end: '04:30',
      status: 'DRAFT',
    },
    {
      n: 5,
      date: addDays(sat1, 7),
      name: 'Black & White Party',
      start: '23:00',
      end: '05:00',
      status: 'DRAFT',
    },
    {
      n: 6,
      date: addDays(sat1, 14),
      name: 'Halloween Warm Up',
      start: '23:00',
      end: '05:00',
      status: 'DRAFT',
    },
  ] as const;
  const ev = (n: number) => did('event', n);
  const LIST_EVENT = 5; // the customer is on this list, with two friends
  const PAST = [1, 2];

  await prisma.$transaction(async (tx) => {
    await tx.venues.create({
      data: {
        id: VENUE,
        name: 'NightHub Demo Club',
        city: 'Piacenza',
        address: 'Via della Notte 1, Piacenza',
        description: 'Locale dimostrativo di NightHub.',
        latitude: new Prisma.Decimal('45.052600'),
        longitude: new Prisma.Decimal('9.692900'),
        radius_geofence: 100,
        bar_price_list: [
          { key: 'birra', label: 'Birra', price: 6 },
          { key: 'cocktail', label: 'Cocktail', price: 10 },
          { key: 'analcolico', label: 'Analcolico', price: 7 },
          { key: 'acqua', label: 'Acqua', price: 3 },
        ],
        bottle_price_list: [
          { key: 'vodka', label: 'Vodka', price: 160 },
          { key: 'champagne', label: 'Champagne', price: 220 },
        ],
      },
    });

    const person = (
      id: string,
      email: string,
      username: string,
      name: string,
      sesso: 'M' | 'F',
      birth: string,
      extra: Partial<Prisma.usersCreateManyInput> = {},
    ) => ({
      id,
      email,
      username,
      name,
      sesso,
      password_hash: PASSWORD_HASH,
      role: 'client' as const,
      birth_date: new Date(birth),
      onboarding_completed_at: new Date(),
      ...extra,
    });
    await tx.users.createMany({
      data: [
        person(
          USERS.cliente,
          'demo.cliente@example.com',
          'demo_cliente',
          'Luca Demo',
          'M',
          '1999-04-12',
        ),
        person(
          USERS.locale,
          'demo.locale@example.com',
          'demo_locale',
          'Gestore Demo Club',
          'M',
          '1988-02-03',
          { role: 'venue', venue_id: VENUE },
        ),
        person(
          USERS.pr,
          'demo.pr@example.com',
          'demo_pr',
          'Marco PR Demo',
          'M',
          '1997-07-21',
        ),
        person(
          USERS.staff,
          'demo.staff@example.com',
          'demo_staff',
          'Staff Demo Club',
          'F',
          '1995-10-30',
          { role: 'staff', venue_id: VENUE },
        ),
        person(
          USERS.amico1,
          'demo.amico1@example.com',
          'giulia_demo',
          'Giulia Demo',
          'F',
          '2000-01-15',
        ),
        person(
          USERS.amico2,
          'demo.amico2@example.com',
          'sara_demo',
          'Sara Demo',
          'F',
          '1998-06-02',
        ),
        person(
          USERS.amico3,
          'demo.amico3@example.com',
          'andrea_demo',
          'Andrea Demo',
          'M',
          '1999-11-09',
        ),
        person(
          USERS.amico4,
          'demo.amico4@example.com',
          'fede_demo',
          'Fede Demo',
          'M',
          '2001-03-27',
        ),
      ],
    });

    await tx.venue_pr_memberships.create({
      data: {
        id: PR_MEMBERSHIP,
        venue_id: VENUE,
        user_id: USERS.pr,
        role: 'responsabile',
        ref_code: PR_CODE,
      },
    });

    // Friends: 3 accepted (two rows per pair), 1 request waiting for the customer.
    await tx.friend_requests.createMany({
      data: [
        ...FRIENDS.map((f, i) => ({
          id: did('freq', i + 1),
          from_user_id: USERS.cliente,
          to_user_id: f,
          status: 'accepted' as const,
        })),
        {
          id: did('freq', 9),
          from_user_id: USERS.amico4,
          to_user_id: USERS.cliente,
          status: 'pending' as const,
        },
      ],
    });
    await tx.friendships.createMany({
      data: FRIENDS.flatMap((f, i) => [
        { id: did('fship', i * 2 + 1), user_id: USERS.cliente, friend_id: f },
        { id: did('fship', i * 2 + 2), user_id: f, friend_id: USERS.cliente },
      ]),
    });

    await tx.events.createMany({
      data: events.map((e) => ({
        id: ev(e.n),
        venue_id: VENUE,
        name: e.name,
        date: e.date,
        description:
          "Serata al NightHub Demo Club. Lista gratuita, ingresso ridotto entro l'01:00.",
        start_time: time(e.start),
        end_time: time(e.end),
        status: e.status,
      })),
    });
    // Price list: Donna 10 € until 01:00, Uomo 15 €, Intero 20 €.
    await tx.event_entry_prices.createMany({
      data: events.flatMap((e) => [
        {
          id: did('price', e.n * 10 + 1),
          event_id: ev(e.n),
          label: 'Donna',
          gender: 'F' as const,
          end_time: time('01:00'),
          price: 10,
        },
        {
          id: did('price', e.n * 10 + 2),
          event_id: ev(e.n),
          label: 'Uomo',
          gender: 'M' as const,
          price: 15,
        },
        {
          id: did('price', e.n * 10 + 3),
          event_id: ev(e.n),
          label: 'Intero',
          price: 20,
        },
      ]),
    });
    await tx.venue_pr_event_assignments.createMany({
      data: events.map((e) => ({
        id: did('assign', e.n),
        venue_id: VENUE,
        event_id: ev(e.n),
        pr_membership_id: PR_MEMBERSHIP,
        assigned_by_user_id: USERS.locale,
      })),
    });

    const prMeta = {
      pr_membership_id: PR_MEMBERSHIP,
      ref_code: PR_CODE,
      pr_code: PR_CODE,
    };

    // Past nights: customer and friends entered (history, levels, venue reports), plus
    // 6 guests without an account and 25 walk-ins per night.
    for (const n of PAST) {
      const night = events[n - 1].date;
      const at = (minutes: number) =>
        new Date(night.getTime() + (23 * 60 + 30 + minutes) * 60_000);
      const members = [USERS.cliente, ...FRIENDS];
      await tx.entries.createMany({
        data: [
          ...members.map((u, i) => ({
            id: did('entry', n * 100 + i),
            event_id: ev(n),
            user_id: u,
            staff_id: USERS.staff,
            pr_membership_id: i < 2 ? PR_MEMBERSHIP : null,
            sesso: gender(i === 1 || i === 2),
            price: i === 1 || i === 2 ? 10 : 15,
            age_bucket: 'AGE_25_29' as const,
            method: 'QR' as const,
            created_at: at(i * 3),
          })),
          ...Array.from({ length: 25 }, (_, i) => ({
            id: did('walkin', n * 100 + i),
            event_id: ev(n),
            staff_id: USERS.staff,
            sesso: gender(i % 2 === 0),
            price: i % 2 ? 15 : 10,
            age_bucket: (
              ['AGE_18_20', 'AGE_21_24', 'AGE_25_29', 'AGE_30_34'] as const
            )[i % 4],
            method: 'RAPIDO' as const,
            created_at: at(10 + i * 4),
          })),
        ],
      });
      await tx.reservations.createMany({
        data: [
          ...members.map((u, i) => ({
            id: did('res', n * 100 + i),
            user_id: u,
            event_id: ev(n),
            type: 'entry' as const,
            status: 'completed' as const,
            guests: 1,
            actual_guests: 1,
            checked_in_at: at(i * 3),
            checked_in_by_staff_id: USERS.staff,
            checkin_entry_id: did('entry', n * 100 + i),
            meta: i < 2 ? prMeta : Prisma.JsonNull,
            created_at: addDays(night, -2),
          })),
          ...Array.from({ length: 6 }, (_, i) => ({
            id: did('gres', n * 100 + i),
            event_id: ev(n),
            type: 'entry' as const,
            status: 'confirmed' as const,
            guests: 1,
            guest_name: [
              'Chiara',
              'Davide',
              'Elena',
              'Matteo',
              'Alice',
              'Simone',
            ][i],
            guest_surname: 'Ospite',
            meta: prMeta,
            created_at: addDays(night, -1),
          })),
        ],
      });
      await tx.venue_stays.create({
        data: {
          id: did('stay', n),
          user_id: USERS.cliente,
          venue_id: VENUE,
          event_id: ev(n),
          entered_at: at(0),
          exited_at: at(200 + n * 15),
          duration_ms: (200 + n * 15) * 60_000,
          exit_source: 'geofence',
        },
      });
    }

    // Upcoming: the customer (2 people, via the PR link) and two friends on one list, so
    // "amici in lista" shows up; a few more names on every upcoming list for the venue/PR.
    await tx.reservations.createMany({
      data: [
        {
          id: did('res', 1),
          user_id: USERS.cliente,
          event_id: ev(LIST_EVENT),
          type: 'entry',
          status: 'confirmed',
          guests: 2,
          qr_token: did('qr', 1),
          meta: prMeta,
        },
        {
          id: did('res', 2),
          user_id: USERS.amico1,
          event_id: ev(LIST_EVENT),
          type: 'entry',
          status: 'confirmed',
          guests: 1,
          qr_token: did('qr', 2),
        },
        {
          id: did('res', 3),
          user_id: USERS.amico2,
          event_id: ev(LIST_EVENT),
          type: 'entry',
          status: 'confirmed',
          guests: 1,
          qr_token: did('qr', 3),
          meta: prMeta,
        },
        ...[3, 4, 5, 6].flatMap((n) =>
          Array.from({ length: 4 + n }, (_, i) => ({
            id: did('gres', n * 100 + i),
            event_id: ev(n),
            type: 'entry' as const,
            status: 'confirmed' as const,
            guests: 1 + (i % 2),
            guest_name: [
              'Chiara',
              'Davide',
              'Elena',
              'Matteo',
              'Alice',
              'Simone',
              'Irene',
              'Pietro',
              'Marta',
              'Nicolò',
            ][i],
            guest_surname: 'Ospite',
            meta: i % 2 ? prMeta : Prisma.JsonNull,
          })),
        ),
      ],
    });
  });

  console.log('Demo created. Password for every account: NightDemo!2026');
  console.log('  Customer:      demo.cliente@example.com');
  console.log('  Venue manager: demo.locale@example.com');
  console.log('  PR:            demo.pr@example.com');
  console.log('  Door staff:    demo.staff@example.com');
  console.log(
    'Upcoming nights:',
    events
      .filter((e) => e.status === 'DRAFT')
      .map((e) => `${e.date.toISOString().slice(0, 10)} ${e.name}`)
      .join(', '),
  );
}

/**
 * Removes every row tied to the demo venue, its events and the demo users, wherever the
 * reviewer may have created some. Follows the foreign keys from those three tables down
 * (e.g. table sales → event tables → events) instead of a hand-kept list, so a new table
 * cannot leave orphans behind. Rows of other tables that only point at a demo user through
 * a nullable "who did it" column (created_by, assigned_by...) keep the row and lose the link.
 */
async function cleanup() {
  const userIds = (
    await prisma.users.findMany({
      where: {
        OR: [
          { id: { in: Object.values(USERS) } },
          { email: { startsWith: 'demo.', endsWith: '@example.com' } },
          { venue_id: VENUE },
        ],
      },
      select: { id: true },
    })
  ).map((u) => u.id);
  const eventIds = (
    await prisma.events.findMany({
      where: { venue_id: VENUE },
      select: { id: true },
    })
  ).map((e) => e.id);
  const targets = new Map<string, Set<string>>([
    ['users', new Set(userIds)],
    ['events', new Set(eventIds)],
    ['venues', new Set([VENUE])],
  ]);

  type Fk = { table: string; column: string; ref: string; nullable: boolean };
  const fks = await prisma.$queryRaw<Fk[]>`
    SELECT kcu.table_name AS "table", kcu.column_name AS "column", ccu.table_name AS ref,
           (c.is_nullable = 'YES') AS nullable
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
    JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
    JOIN information_schema.columns c ON c.table_schema = kcu.table_schema AND c.table_name = kcu.table_name AND c.column_name = kcu.column_name
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`;
  const OWNER_COLUMNS = [
    'user_id',
    'reporter_id',
    'reported_user_id',
    'blocker_id',
    'blocked_id',
    'from_user_id',
    'to_user_id',
    'friend_id',
  ];
  const unlinkOnly = (fk: Fk) =>
    fk.ref === 'users' && fk.nullable && !OWNER_COLUMNS.includes(fk.column);
  const ids = (table: string) => [...(targets.get(table) ?? [])];

  // Collect the rows to delete, level by level, until nothing new turns up.
  for (let grew = true; grew; ) {
    grew = false;
    for (const fk of fks) {
      if (fk.table === fk.ref || unlinkOnly(fk) || !ids(fk.ref).length)
        continue;
      const rows = await prisma
        .$queryRawUnsafe<
          { id: string }[]
        >(`SELECT id::text AS id FROM "${fk.table}" WHERE "${fk.column}" = ANY($1::uuid[])`, ids(fk.ref))
        .catch(() => []); // table without an id column: deleted below by its foreign key anyway
      const set = targets.get(fk.table) ?? new Set<string>();
      for (const r of rows) {
        if (set.has(r.id)) continue;
        set.add(r.id);
        grew = true;
      }
      targets.set(fk.table, set);
    }
  }

  for (const fk of fks.filter(unlinkOnly)) {
    await prisma.$executeRawUnsafe(
      `UPDATE "${fk.table}" SET "${fk.column}" = NULL WHERE "${fk.column}" = ANY($1::uuid[])`,
      userIds,
    );
  }
  // Delete children first; a failure means a child is still there, so retry on the next pass.
  for (let pass = 0; pass < 8; pass++) {
    let failed = 0;
    for (const fk of fks) {
      if (unlinkOnly(fk) || !ids(fk.ref).length) continue;
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM "${fk.table}" WHERE "${fk.column}" = ANY($1::uuid[])`,
          ids(fk.ref),
        )
        .catch(() => failed++);
    }
    for (const table of ['events', 'users', 'venues']) {
      await prisma
        .$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE id = ANY($1::uuid[])`,
          ids(table),
        )
        .catch(() => failed++);
    }
    if (!failed) break;
  }

  const left =
    (await prisma.users.count({ where: { id: { in: userIds } } })) +
    (await prisma.venues.count({ where: { id: VENUE } }));
  if (left)
    throw new Error(
      `Cleanup incomplete: ${left} demo users/venue still referenced somewhere.`,
    );
  console.log(
    `Demo removed (${userIds.length} users, ${eventIds.length} events).`,
  );
}

/** Venue offset for --edge: outside the 150 m geofence, inside 150 m + the app's 50 m margin. */
const EDGE_OFFSET_M = 190;

async function testStay(lat: number, lng: number, edge: boolean) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Usage: --test-stay <latitude> <longitude> [--edge]');
  }
  const you = { lat, lng };
  if (edge) lat += EDGE_OFFSET_M / 111_320; // metres → degrees of latitude
  if (!(await prisma.venues.findUnique({ where: { id: VENUE } }))) {
    throw new Error('Demo venue not found: create the demo first.');
  }
  const event = did('event', 99);
  await prisma.$transaction([
    prisma.venues.update({
      where: { id: VENUE },
      data: {
        latitude: new Prisma.Decimal(lat.toFixed(6)),
        radius_geofence: 150,
        longitude: new Prisma.Decimal(lng.toFixed(6)),
      },
    }),
    prisma.events.upsert({
      where: { id: event },
      update: { date: today },
      create: {
        id: event,
        venue_id: VENUE,
        name: 'Test posizione',
        date: today,
        start_time: time('00:01'),
        end_time: time('23:59'),
        status: 'LIVE',
      },
    }),
    prisma.venue_stays.updateMany({
      where: { user_id: USERS.cliente, exited_at: null },
      data: { exited_at: new Date(), exit_source: 'auto' },
    }),
    prisma.venue_stays.create({
      data: {
        user_id: USERS.cliente,
        venue_id: VENUE,
        event_id: event,
        entered_at: new Date(),
      },
    }),
  ]);
  console.log(
    `Stay opened for demo.cliente, venue at ${lat.toFixed(6)}, ${lng.toFixed(6)} (geofence radius 150 m).`,
  );
  console.log(
    edge
      ? `Venue placed ${EDGE_OFFSET_M} m north of you (${you.lat}, ${you.lng}). Open NightHub as demo.cliente, allow "Always", then run --test-status.`
      : 'Open NightHub logged in as demo.cliente@example.com, then walk 300+ m away.',
  );
}

async function testLeave() {
  const stay = await prisma.venue_stays.findFirst({
    where: {
      user_id: USERS.cliente,
      event_id: did('event', 99),
      exited_at: null,
    },
    select: { entered_at: true },
  });
  if (!stay) throw new Error('No open test stay: run --test-stay first.');
  const venue = await prisma.venues.findUniqueOrThrow({
    where: { id: VENUE },
    select: { latitude: true },
  });
  await prisma.venues.update({
    where: { id: VENUE },
    data: {
      latitude: new Prisma.Decimal(
        (Number(venue.latitude) + EDGE_OFFSET_M / 111_320).toFixed(6),
      ),
    },
  });
  const minutes = Math.round((Date.now() - stay.entered_at.getTime()) / 60_000);
  console.log(
    `Venue moved ${EDGE_OFFSET_M} m away: for the phone you have just left, after ${minutes} min inside.`,
  );
  console.log('Open NightHub, wait ~30 s, then run --test-status.');
}

async function testExit() {
  const login = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      identifier: 'demo.cliente@example.com',
      password: 'NightDemo!2026',
    }),
  });
  const { access_token: token } = (await login.json()) as {
    access_token?: string;
  };
  if (!token) throw new Error(`Login failed (${login.status}).`);
  // Same body the app sends from the geofence task (venueStaysApi.exit).
  const res = await fetch(`${API_URL}/venue-stays/checkpoint`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      venue_id: VENUE,
      event_id: did('event', 99),
      event_type: 'exit',
      exit_source: 'geofence',
    }),
  });
  console.log(
    `POST /venue-stays/checkpoint → ${res.status}${res.ok ? '' : ` ${await res.text()}`}`,
  );
  await testStatus();
}

async function testStatus() {
  const stay = await prisma.venue_stays.findFirst({
    where: { user_id: USERS.cliente, event_id: did('event', 99) },
    orderBy: { entered_at: 'desc' },
  });
  if (!stay) return console.log('No test stay: run --test-stay first.');
  if (!stay.exited_at)
    return console.log(
      `Still open (entered ${stay.entered_at.toLocaleTimeString('it-IT')}): no exit recorded yet.`,
    );
  console.log(
    `Exit recorded at ${stay.exited_at.toLocaleTimeString('it-IT')} via "${stay.exit_source}"` +
      ` after ${Math.round((stay.duration_ms ?? 0) / 60_000)} min.` +
      (stay.exit_source === 'geofence'
        ? ' If you did not use --test-exit, the background geofence works.'
        : ' (app = detected when reopening the app)'),
  );
}

(CLEANUP
  ? cleanup()
  : TEST_STAY > 0
    ? testStay(
        Number(process.argv[TEST_STAY + 1]),
        Number(process.argv[TEST_STAY + 2]),
        process.argv.includes('--edge'),
      )
    : TEST_LEAVE
      ? testLeave()
      : TEST_EXIT
        ? testExit()
        : TEST_STATUS
          ? testStatus()
          : seed()
)
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
