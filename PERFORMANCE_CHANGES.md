# NightHub Backend — Performance Changes (Priority 1: Quick Wins)

Companion to `PERFORMANCE_AUDIT.md`. This covers only the Priority 1 items implemented in this pass — all safe, non-breaking, verified with `tsc --noEmit`, `nest build`, `eslint`, and the existing Jest suite (all green). No API contracts, response shapes, or DTOs changed.

**Note on diff size:** fixing the lint errors my own new lines introduced required running `eslint --fix` on the touched files. Several of those files (`venues.service.ts`, `events.service.ts`, `reservations.service.ts` especially) had substantial pre-existing prettier violations that were never fixed before, so `--fix` reformatted some unrelated pre-existing lines alongside mine. This is formatting-only (verified via `tsc`/build/tests) — no logic outside the changes below was touched. If you'd rather keep the diff scoped strictly to logic changes, I can redo this without the `--fix` pass.

---

## Changes

### 1. Global `ValidationPipe` registered
**Problem:** Several DTOs (`LoginDto`, `RegisterDto`, etc.) carry `class-validator` decorators, but no `ValidationPipe` was ever registered — they were dead code, so malformed request bodies reached Prisma/business logic unvalidated.
**Solution:** `app.useGlobalPipes(new ValidationPipe({ transform: true }))` in `src/main.ts`. Deliberately **not** enabling `whitelist`/`forbidNonWhitelisted`: 4 DTOs (`events` create/update, `payments` checkout/payment-sheet) have zero validation decorators today, and whitelisting would silently strip every field on those bodies, breaking event creation and checkout. Enabling `whitelist` is a good Priority 2 follow-up once those DTOs get decorators.
**Impact:** DTOs that already have decorators (auth, most venues/staff/friends DTOs) now actually validate and type-coerce incoming payloads, producing clean 400s instead of deeper runtime/Prisma errors on bad input.
**Risk:** Low. `transform: true` without `whitelist` doesn't remove or reject any field that passed through before; it only adds validation for fields that already had decorators (which by definition weren't being enforced before, so no existing valid request can start failing).

### 2. `GET /events` no longer writes to the DB on every read
**Problem:** `listEvents`/`listEventsPaginated` synced each event's computed status to the DB via one `UPDATE` per drifted row, in a `Promise.all` over the whole result set — a read endpoint doing N writes.
**Solution:** New `syncEventStatusesIfNeeded()` in `events.service.ts` groups drifted event ids by target status and issues at most one `updateMany` per distinct status (in practice ≤2: LIVE, CLOSED) instead of one `update` per row. Replaces the old per-row `syncEventStatusIfNeeded` loop in all 4 list call sites (`listEvents` × 2 branches, `listEventsPaginated` × 2 branches). The single-event path (`getEvent`) still does one write for one row, which was never the N+1 problem.
**Impact:** Collapses up to N writes per list call into ≤2. Not measured (no load-test environment available), but this removes the dominant source of unpredictable latency/write load on the most-hit endpoint in the API.
**Risk:** Low. Same end state (DB status ends up correct), same best-effort error handling (failures are swallowed, matching prior behavior).

### 3. `JwtAuthGuard` no longer blocks every request on an activity-tracking write
**Problem:** `touchUserActivity` was `await`ed inside `canActivate`, so every single authenticated request paid a DB round-trip (an `updateMany` with a throttle `WHERE`), even though the method itself already treats the write as best-effort/non-critical.
**Solution:** Changed to fire-and-forget (`void this.authService.touchUserActivity(id).catch(...)`) with the guard's own logger recording failures instead of propagating them.
**Impact:** Removes one blocking DB round-trip from the critical path of every authenticated API call.
**Risk:** Low. The write was already "best-effort" per the existing code's own comments/try-catch; not awaiting it doesn't change whether it eventually happens, only whether the response waits for it. On serverless, the write starts well before the response is sent (the guard runs at the very start of request handling), so it has ample time to complete in the vast majority of cases.

### 4. Atomic, lock-safe `entrati` counter update
**Problem:** `updateHostessTableEntrati` did a plain read-then-write (`table.entrati + delta` computed in JS, then `update`) — a genuine lost-update race under concurrent door-scan updates to the same table, with no DB constraint protecting it.
**Solution:** Wrapped in `$transaction` with `SELECT ... FOR UPDATE` to lock the row before computing the new value, preserving the exact same validation (non-negative check, `confermato` reset) but now serialized per-row.
**Impact:** Eliminates the lost-update race under concurrent staff scans of the same table.
**Risk:** Low. Same business logic, same return shape; only the concurrency safety changed. Row-level lock is scoped to a single `event_tables` row and released at transaction end, so no broader contention introduced.

### 5. Safety-net `take` limits on unbounded list queries
**Problem:** Several `findMany()` calls had no `take` at all: `venues.listVenues`, `staff.listEntries`/`listBarSales`/`listCloakroomSales`/`listTableSales`.
**Solution:** Added generous caps (1000 for venues, 5000 for the append-only staff lists) well above any realistic current row count for a single venue/event — today's responses are unaffected; the cap only kicks in as data grows.
**Impact:** Removes the unbounded-scan risk without changing any current response.
**Risk:** None today (caps are far above current data volumes); true pagination for these lists is a larger Priority 2/3 change if these tables grow enough to need it.

### 6. `GET /reservations/table-invitations/incoming` scoped and bounded
**Problem:** Scanned every non-filtered table reservation system-wide (including already-cancelled ones) to find invites for the current user via a JSON `meta` field scan.
**Solution:** Added `status: { not: 'cancelled' }` (cancelled reservations can't meaningfully be "incoming" invitations — this is a correctness improvement, not just perf) and a `take: 2000` safety cap.
**Impact:** Reduces scan size; also fixes a latent correctness issue (cancelled table requests showing as pending invitations).
**Risk:** Low-medium — this is the one change in this batch that narrows *which* rows come back (excludes cancelled), flagged here explicitly so you can confirm it matches intended product behavior.

### 7. Parallelized independent sequential queries
**Problem:** Several places `await`ed two or more DB calls back-to-back that don't depend on each other's results.
**Solution:** Converted to `Promise.all` in:
- `reservations.createReservation` — event lookup + user role lookup.
- `staff.recordEntry` — push-token lookup + event/venue lookup (also trimmed the venue `include` down to a `select` of the 5 fields actually used, instead of the full venue row).
- `friends.sendRequest` — existing-friendship check + existing-request check.
- `admin.getDashboard` — the two trailing `groupBy` calls that ran after (not inside) the main `Promise.all` despite being independent of its results.
- `users.getMe`/`updateMe` — user record fetch + PR-membership lookup, via a new shared synchronous `formatCurrentUser()` helper (replacing the old `toCurrentUser()` that always awaited the membership lookup *after* the user record was already in hand).
**Impact:** Each of these shaves one full DB round-trip of latency off its endpoint (exact ms not measured — no load environment available).
**Risk:** None — verified independent by inspection (different tables/no shared filters), and confirmed no behavior depends on call order.

### 8. `POST /promos` no longer blocks on the push notification fan-out
**Problem:** `createPromo` `await`ed `sendPromoCreatedPush` (an unbounded fetch of every client user with a push token, then a push fan-out) before responding.
**Solution:** Fire-and-forget with error logging, matching the pattern already used elsewhere in the codebase for non-critical side effects.
**Impact:** `POST /promos` response no longer waits on the full push pipeline.
**Risk:** Low. Push delivery was already best-effort (no caller depends on its result); only the response timing changed.

---

## Second pass: additive cookie-session auth + more Priority 2 items

### 9. Additive httpOnly session cookie (unlocks Next.js SSR for personalized routes)
**Problem (raised by the frontend audit):** the JWT only ever existed in the browser (`localStorage`), so Next.js Server Components/Route Handlers had no way to read it and fetch personalized data server-side — forcing every personalized screen to be a Client Component.
**Solution, confirmed additive (not replacing Bearer, since this API also serves a mobile/Expo client):**
- `POST /auth/login` now **also** sets an httpOnly, `Secure` (in production), `SameSite` cookie (`nighthub_session`) carrying the exact same JWT — the JSON response body is unchanged (`access_token` still returned as before).
- `JwtAuthGuard` accepts the token from either the `Authorization: Bearer` header (checked first, so mobile is unaffected) or the cookie (fallback, for browser requests that don't set the header).
- `POST /auth/logout` and `DELETE /auth/me` now also clear the cookie and revoke whichever token(s) were presented (header and/or cookie).
- Added `cookie-parser` middleware.
- **CORS changed from `enableCors()` (wildcard, no credentials) to an explicit origin allow-list with `credentials: true`** — required because credentialed cross-origin requests can't use a wildcard origin. Origins come from a new `CORS_ORIGINS` env var (comma-separated); falls back to common `localhost` dev origins if unset.
**Impact:** unblocks server-side data fetching for personalized Next.js routes (the actual perf win happens on the frontend once it adopts this — this change only makes it possible).
**Risk / action required before deploy:** **`CORS_ORIGINS` must be set in every deployed environment (Vercel, staging, etc.) to the real frontend origin(s).** Without it, the fallback list only allows `localhost`, and browser requests from the deployed frontend will start failing CORS. This is the one change in this pass that is a real deploy-time requirement, not just a safe drop-in — flagging it clearly rather than burying it.
**Not done:** the frontend still needs to switch its fetch calls to `credentials: 'include'` and have Server Components/Route Handlers read the cookie — that's frontend work, out of scope here.

### 10. Fixed a real bootstrap drift between the two deployment entrypoints
**Problem found while wiring up the cookie:** this repo has two separate Nest bootstrap paths — `src/main.ts` (local dev / fallback) and `api/index.ts` (the **actual Vercel production entrypoint**, per `vercel.json`'s `functions: { "api/index.ts": ... }` and its rewrite rule). They had drifted apart: `api/index.ts` was missing the global `ValidationPipe` from change #1 of this document, the JSON body-size override, and (until now) would have been missing the cookie/CORS work too if only `main.ts` had been touched.
**Solution:** extracted the shared setup into `src/bootstrap.ts` (`createApp()`), used by both `src/main.ts` and `api/index.ts`. One function, two thin entrypoints — no more drift possible.
**Impact:** change #1 (`ValidationPipe`) is now actually live in production for the first time — it was silently inert there before this fix, despite being "done" in the first pass of this document.
**Risk:** Low — pure refactor, verified via `tsc`/build; behavior for local dev (`main.ts`) is unchanged, `api/index.ts` gains the features described in #1 and #9.

### 11. `GET /events/:id` — trimmed the `venue` include
**Problem:** `include: { venue: true }` returned every venue column, including Stripe account/payout status and contract billing fields, on every event-detail fetch.
**Solution:** Replaced with a `select` of the display-relevant fields (name, city, address, description, image, geolocation, radius_geofence, price fields, timestamps) — excludes only the Stripe/contract billing fields, which are inputs to venue-owner/admin views, not event detail.
**Risk:** Low-medium — kept a broad set of fields to minimize the chance of removing something the frontend reads; if the event-detail screen turns out to need a Stripe/contract field (unlikely), it's a one-line addition to the `select`.

### 12. Badge criteria engine: shared `entries` fetch instead of one-per-criteria-type
**Problem:** `distinct_venues_count`, `weekend_streak`, `event_before_time`, `event_after_time`, and `seasonal_window` each independently ran their own `entries.findMany` for the same user within a single evaluation pass (badge sweep on friend-accept, or the badges screen).
**Solution:** Added `createEntriesCache(userId)` — a per-call memoized fetch (one shared `entries.findMany` with the union of fields all five criteria types need: `venue_id`, `start_time`, `date`). `computeProgress` now takes this cache and each affected branch reads from it instead of querying independently. `computeWeekendStreak`, `countEntriesByEventTime`, `countEntriesInSeasonalWindow` are now pure functions over already-fetched rows instead of each issuing their own query.
**Impact:** for a user with badges spanning multiple of these criteria types, collapses up to 5 `entries` scans into 1 per evaluation pass (`evaluateForUser` and `getBadgesForViewer` each create their own cache, scoped to that one call).
**Risk:** Low. Same data, same logic per criteria type — only the fetch is now shared and memoized instead of repeated. `computeWeekendStreak` no longer requests `orderBy: { event: { date: 'asc' } }` from the DB, but the function already deduplicates into a `Set` and sorts the resulting week-keys itself, so it never depended on row order to begin with.

### 13. `listVenueTransactions` — reduced (not eliminated) the Stripe N+1
**Problem:** for each of up to 100 orders, the endpoint called Stripe twice sequentially (resolve ticket amount, then resolve refunds) — up to ~300 sequential Stripe round trips per request.
**Solution (partial — a full fix needs a schema change, see "still open" below):**
- The two Stripe calls per order (ticket amount, refunds) are independent of each other and now run via `Promise.all` instead of sequentially — halves the per-order latency contribution.
- The refunds lookup (`resolveTicketRefundedCents`) is now skipped entirely for any order whose `status !== 'paid'` (only paid orders can have refunds), instead of always being called whenever a `stripe_payment_intent` id is present. Reduces call volume for `created`/`cancelled`/`failed` orders that still recorded a payment intent id.
**Impact:** cuts Stripe round-trip count for non-paid orders, and halves the critical-path latency per paid order (2 sequential calls → 1 round-trip time via parallelization). Not measured.
**Still open, deferred:** the `paymentIntents.retrieve` call for ticket-amount resolution still happens on every call for every paid order — Stripe has no bulk "get many by id" endpoint, so the only way to actually eliminate this N+1 (not just shrink it) is to persist the resolved amount on `ticket_orders` after first resolution (write-through cache) and skip Stripe entirely on repeat views. That needs a new nullable column + migration, and I didn't have a live DB in this session to validate a migration against, so I left it as a flagged next step rather than shipping unverified schema changes.

### 14. Bulk table/station creation — batched instead of per-row sequential
**Problem:** `createVenueStationsBulk` (≤50 rows) and `createVenueTablesBulk` (≤300 rows) each looped with `for (const row of rows) { await find...; await create/update... }` — up to ~100 and ~1200 sequential round trips respectively, inside one open transaction.
**Solution:**
- **Stations:** one `findMany` for all existing stations in the venue (replacing per-row `findFirst`), split into `createMany` for new ones and `Promise.all` of per-row `update` for existing ones (still per-row since each has different data, but no longer interleaved with reads, and no longer sequential). Duplicate names *within* the same request are deduped up front (last one wins), matching the previous sequential loop's effective behavior and avoiding a `createMany` unique-constraint failure.
- **Tables:** this endpoint manages at most one `venue_table` per zone (a later row targeting the same `zona` overwrites the same row), so rows are first deduped by zone (last wins, same reasoning as stations), then: one query for the starting zone count (used to assign new zones' `sort_order` locally instead of one `count()` per row), one `findMany` for existing zones by name, zone upserts run via `Promise.all` (still one per *distinct zone*, not per row — Prisma has no batch-upsert-with-per-row-data), one `findMany` for existing table rows across all touched zones (replacing per-row `findFirst`), then `createMany` for new rows and `Promise.all` of `update` for existing ones.
**Impact:** for the tables endpoint specifically, collapses up to ~4 sequential queries per *row* into roughly `2 + 3×(distinct zones)` queries per *request* — for a typical bulk import where many rows share a handful of zones, this is a large reduction; worst case (every row a distinct zone) is still much better than before since reads are batched and independent writes are parallelized instead of interleaved.
**Risk:** Low-medium — this is the most intricate change in this pass (zone/table upsert interdependency). Preserved the exact existing "last row per zone wins" semantics and the "at most one venue_table per zone" invariant. Verified via `tsc`/build/tests, but this endpoint (admin bulk import) is a good candidate for a manual smoke test before relying on it in production.

### 15. `ensureEventTablesSeeded` — removed one redundant query per call
**Problem:** every call (which runs at the top of `GET /staff/hostess-tables`, `GET /staff/waiter/tables`, `GET /staff/bottle-orders`) fetched `event_tables` twice: once to decide whether to seed, and again afterward to compute `prenotati` sync diffs — even though nothing could have changed between those two fetches other than the seeding `createMany` this function itself just ran.
**Solution:** when the seeding branch runs (`createMany`), the new rows already have the correct `prenotati` inline, so there's nothing left to reconcile — return immediately instead of re-fetching. When it doesn't run (rows already existed), reuse the first fetch instead of re-querying the same rows a second time.
**Impact:** removes one full `event_tables.findMany` per call to these three endpoints (roughly a 20-30% cut in this function's own query count, depending on venue table count).
**Not done:** the audit's full recommendation — moving this reconciliation off the GET path entirely (running it on table/reservation writes instead of on every read) — was **not** attempted. That's a larger behavioral change (which write paths should trigger it? what happens to in-flight reads during the gap?) that needs its own design pass rather than a quick edit; doing it wrong risks stale/missing `event_tables` rows on a screen staff rely on live during an event, which is a worse failure mode than the extra query it would save. Left as-is beyond the redundant-query removal above.

### 16. Found and fixed via live testing: `JwtAuthGuard` was hitting the DB on nearly every authenticated request
**Discovered by:** running the app against a real (dev/staging) database and benchmarking every endpoint (see results table below) — not from code review. Every authenticated request, successful or rejected, had a suspicious ~250-500ms floor that shouldn't have been there.
**Root cause:** `JwtAuthGuard`'s backward-compatibility fallback (`src/auth/jwt-auth.guard.ts`) was meant to look up `venue_id` from the DB only for *old tokens issued before that claim existed*. It checked `if (resolvedVenueId === null || resolvedVenueId === undefined)` — but `venue_id: null` is the **normal, correct** value for every client-role user (they have no venue). Since the claim is always present (just `null`) in every token issued by the current login code, this condition was true for every client-role request, triggering a real round-trip to the (remote) database on every single authenticated call from every regular app user — the majority of traffic.
**Solution:** changed the check to test whether the claim is present at all (`'venue_id' in payload || 'venueId' in payload`) rather than whether its resolved value is null. Old tokens that truly predate the claim still get the DB fallback; every current token (which always includes the claim) never does.
**Measured impact (this session, same machine, same remote dev DB, before vs. after — see full table below):**
- Role-gated endpoints rejected by `RolesGuard` (403): **~480-960ms → ~1-2ms** server-side (`X-Response-Time`). This is the guard overhead in isolation, and it's now essentially free.
- Successful authenticated `GET` endpoints with light logic (`/users/me`, `/badges/me`, `/friends`, `/reservations`, etc.): **~715-970ms → ~236-243ms**, i.e. roughly **480ms shaved off every authenticated request**, matching the removed round-trip almost exactly.
**Risk:** Low. The fallback still exists and still works for genuinely old tokens (verified logically: `'venue_id' in payload` is `false` only when the key is truly absent from the decoded JWT, which is exactly the case the fallback was written for).
**Why the earlier code-review pass missed this:** the code looked correct on a read-through (a `=== null` check "for backward compatibility" reads as reasonable) — the bug only became obvious by decoding a real issued token and seeing `venue_id: null` explicitly present, then correlating that with the measured latency floor.

### 17. Found and fixed via live testing: `GET /events/sync-status` was completely unreachable
**Discovered by:** the same endpoint sweep — the route returned `500 Internal Server Error` with a Prisma "invalid UUID" error instead of running.
**Root cause:** pure route-ordering bug in `events.controller.ts`. NestJS (via Express) matches routes in registration order, and `@Get('events/:id')` was registered *before* `@Get('events/sync-status')`. Every request to `/events/sync-status` matched the `:id` route first, with `id` literally set to the string `"sync-status"`, which then failed as an invalid UUID when passed to Prisma.
**Impact:** this endpoint is used by a cron job (per its own comment: "Used by Vercel Cron... to keep DB status up-to-date even with no client traffic") — it was silently never running, which likely explains why event statuses sometimes only got corrected on-demand (via the read-path sync fixed in change #2) rather than proactively.
**Solution:** moved the `syncStatus` handler above `getOne` (`events/:id`) in the controller, with a comment explaining why the order matters, so this class of bug can't silently reappear if someone adds another `events/:something` route later without noticing.
**Verified:** re-tested after the fix — `GET /events/sync-status` now correctly reaches its handler (returns `403 Invalid cron secret` for an unauthenticated call, as expected, instead of `500`).
**Risk:** Low — pure reordering, no logic changed. If this cron endpoint is wired up in Vercel's cron config, it should be verified there too now that it will actually execute.

---

## Live endpoint benchmark (this session)

Run against a real dev/staging database (confirmed safe by you before running), same machine, immediately before and after fix #16 above, using a fresh test client user (registered and deleted at the end of this session) and one existing venue/event from the dev data. `X-Resp-Time` is the app's own `Server-Timing`/`X-Response-Time` header (request-handling time only); `TOTAL` is curl's end-to-end time, which includes a consistent ~200-215ms of local tooling/connection overhead visible even on `/health` — treat `X-Resp-Time` as the real app-side number.

**Before fix #16** (excerpt — full run included every endpoint listed below):

| Endpoint | Code | X-Resp-Time |
|---|---|---|
| `GET /health` | 200 | 0.3ms |
| `GET /venues` | 200 | 283.8ms |
| `GET /events/:id` | 200 | 1067.6ms |
| `GET /users/me` | 200 | 963.2ms |
| `GET /friends` | 200 | 719.6ms |
| `GET /badges/user/:userId` | 200 | 2051.0ms |
| `GET /venues/:id/analytics` (403, wrong role) | 403 | 477.7ms |
| `GET /admin/dashboard` (403, wrong role) | 403 | 478.5ms |
| `GET /staff/hostess-tables` (403, wrong role) | 403 | 479.4ms |

**After fix #16** (same run, same endpoints):

| Endpoint | Code | X-Resp-Time | Change |
|---|---|---|---|
| `GET /health` | 200 | 0.6ms | ~0 |
| `GET /venues` | 200 | 292.0ms | ~0 (no auth on this one) |
| `GET /events/:id` | 200 | 1057.3ms | ~0 (public endpoint, not guard-bound; still the heaviest single endpoint - see #11/audit §2) |
| `GET /users/me` | 200 | 240.3ms | **-723ms** |
| `GET /friends` | 200 | 238.9ms | **-480ms** |
| `GET /badges/user/:userId` | 200 | 1306.5ms | **-745ms** (still the slowest authenticated endpoint - see below) |
| `GET /venues/:id/analytics` (403, wrong role) | 403 | 0.9ms | **-477ms** |
| `GET /admin/dashboard` (403, wrong role) | 403 | 1.6ms | **-477ms** |
| `GET /staff/hostess-tables` (403, wrong role) | 403 | 0.8ms | **-479ms** |

**Full post-fix results, every endpoint tested, sorted by X-Resp-Time:**

| Endpoint | Method | Code | X-Resp-Time | Note |
|---|---|---|---|---|
| `/health` | GET | 200 | 0.6ms | |
| `/venues/:id/stations` | GET | 401 | 0.9ms | no token sent (guard rejects before any work) |
| `/venues/:id/pricing` | GET | 401 | 0.4ms | " |
| `/promos/active` | GET | 401 | 0.7ms | " |
| `/badges/catalog` | GET | 401 | 0.3ms | " |
| `/venues/:id/analytics` (+ `/overview`, `/demographics`, `/revenue-breakdown`, `/stats`) | GET | 403 | 0.8-1.0ms | client role, venue-only endpoint |
| `/staff/*` (hostess-tables, waiter/tables, entries, bar-sales, cloakroom-sales, table-sales, bottle-orders, events/:id/stats) | GET | 403 | 0.8-0.9ms | client role, staff-only endpoints |
| `/admin/*` (dashboard, venues, users, reports, profile) | GET | 403 | 0.8-1.6ms | client role, admin-only endpoints |
| `/payments/venue/transactions` | GET | 403 | 0.8ms | client role, venue/admin-only |
| `/friends/search?q=a` | GET | 200 | 1.4ms | |
| `/users/me` | GET | 200 | 240.3ms | |
| `/badges/me` | GET | 200 | 240.7ms | |
| `/badges/level` | GET | 200 | 239.5ms | |
| `/friends` | GET | 200 | 238.9ms | |
| `/friends/map` | GET | 200 | 236.8ms | |
| `/friends/tonight` | GET | 200 | 237.4ms | |
| `/friend-groups` | GET | 200 | 239.5ms | |
| `/reservations` | GET | 200 | 238.1ms | |
| `/venue-stays` | GET | 200 | 242.3ms | |
| `/events/:id/friends-going` | GET | 200 | 235.8ms | |
| `/reservations/booked-tables` | GET | 200 | 237.8ms | |
| `/reservations/booked-zones` | GET | 200 | 242.2ms | |
| `/venues/:id` | GET | 200 | 241.1ms | |
| `/events/:id/promos` | GET | 200 | 240.4ms | |
| `/public/promos/active` | GET | 200 | 238.9ms | |
| `/venues` | GET | 200 | 292.0ms | no auth guard cost, own DB query |
| `/events` | GET | 200 | 335.9-339.3ms | |
| `/venues/:id/events` | GET | 200 | 334.3ms | |
| `/friends/requests` | GET | 200 | 380.0ms | |
| `/reservations/table-invitations/incoming` | GET | 200 | 428.2ms | |
| `/venues/:id/table-zones` | GET | 200 | 488.0ms | |
| `/venues/:id/tables` | GET | 200 | 481.0ms | |
| `/venues/:id/pr-network` | GET | 403 | 473.8ms | not a guard rejection - this route allows the `client` role at `@Roles(...)`, so the 403 comes from a real authorization check inside `listVenuePrNetworkMembers` (querying whether the caller is a PR member of this venue) before it denies access; the ~474ms is genuine DB work, not overhead |
| `/events/:id` | GET | 200 | 1057.3ms | heaviest public endpoint - matches audit finding (table pricing + floor plan resolution, see audit §2) |
| `/venues/:id/floor-plan` | GET | 200 | 1072.8ms | matches audit finding on floor-plan resolution cost |
| `/badges/user/:userId` | GET | 200 | 1306.5ms | heaviest authenticated endpoint - the badge dedup fix (#12) helped but several criteria types (`friends_count`, `spend_total`, `account_age_days`, `profile_completed`, `early_adopter`) still run one query each per badge, uncached; a full badge catalog still means dozens of small queries per view |
| `/events/sync-status` | GET | 403 | n/a | was `500` before fix #17, now correctly reachable |

**Endpoints not tested:** all write endpoints (`POST`/`PATCH`/`PUT`/`DELETE`) were intentionally not exercised in this pass to avoid mutating the dev database beyond the one throwaway test user (registered and deleted at the end). Role-gated endpoints were only tested with a `client`-role token, so their 403 numbers reflect guard overhead, not the actual handler cost for `staff`/`venue`/`admin` roles — a follow-up run with role-specific test accounts would be needed to measure those handlers' real latency.

## Third pass: full role-based live testing (client/staff/venue/admin) + more fixes

Tested every `GET` endpoint against all four real roles (using the `staff@example.com`, `venue@example.com`, `admin@example.com` accounts you provided, plus a throwaway client account registered and deleted at the end) instead of just a client token. This surfaced one more critical regression and several genuine staff/venue-side bottlenecks that a client-only test couldn't have found.

### 18. CRITICAL regression found and fixed: the new `ValidationPipe` broke user registration
**Discovered by:** trying to register a test client account with a minimal payload (email/username/password/name only, no `role`/`sesso`/`birth_date`) - the same shape a mobile client would send for a normal signup. It failed with `400 Bad Request`.
**Root cause:** `RegisterDto` declares `role`, `sesso`, and `birth_date` as **required** (`@IsString() role: string`, no `@IsOptional()`), but `auth.service.ts#register` has always treated them as optional (`dto.role ?? UserRole.client`, `dto.sesso ?? undefined`, only parses `birth_date` `if (dto.birth_date)`). Before change #1 in this document, these decorators were never enforced (no `ValidationPipe` existed), so this mismatch was invisible - registration worked fine without those fields. The moment the global `ValidationPipe` went live, it started rejecting exactly the request shape the service was written to accept.
**Impact if shipped as-is:** would have broken registration for any client that doesn't send `role`/`sesso`/`birth_date` - very likely the actual mobile app's normal signup flow, discovered before deploy only because of this live-testing pass.
**Solution:** added `@IsOptional()` to all three fields in `RegisterDto`, matching the service's actual (and correct) behavior.
**Verified:** re-tested after the fix - minimal-payload registration now succeeds again.
**Lesson applied going forward:** this is exactly the class of bug the `PERFORMANCE_AUDIT.md` §8 flagged as a risk of enabling `ValidationPipe` without first auditing every DTO against its service's actual field requirements. One instance is now fixed and verified; the other DTOs haven't been individually re-audited against their services beyond what live-testing happened to exercise in this session (see "Still open" below).

### 19. `recalculateEventStats` — removed the same "fetch everything just to check existence" pattern as change #11, now measured
**Measured before fixing:** `GET /events/:id/stats` (venue/admin role) and `GET /staff/events/:eventId/stats` (staff/venue/admin) were the single slowest authenticated endpoints found in this pass: **1565-1861ms**.
**Root cause (same as flagged, but not yet fixed, in the original audit §2 as a LOW-priority item — turned out to be much more expensive than that label suggested):** `recalculateEventStats` called `await this.getEvent(eventId)` - the full `getEvent` chain (venue include, promos, entry_prices, plus the two extra transactions for table-pricing/floor-plan resolution) - purely to `throw NotFoundException` if the id doesn't exist, then discarded the entire result and ran its own 4-query aggregate `$transaction`.
**Solution:** replaced with a bare `findUnique({ select: { id: true } })` existence check.
**Measured after:** **768-1061ms** - roughly halved (the remaining cost is the genuinely-needed 4-way aggregate transaction plus this endpoint's own guard overhead, not further reducible without changing what data it aggregates).

### 20. `ensureEventTablesSeeded` and its three callers — parallelized independent queries
**Measured before fixing:** `GET /staff/hostess-tables`, `/staff/waiter/tables`, `/staff/bottle-orders` (staff/venue role) were **1180-1930ms** each - the heaviest *class* of endpoint found, and these are staff-facing screens meant to be used live, repeatedly, during an event.
**Root cause:** `ensureEventTablesSeeded` awaited 3 independent queries sequentially (event existence+venue_id, venue's tables, this event's existing event_tables rows) even though 2 of the 3 don't depend on each other. Each of its 3 callers then did further sequential, independent work on top: `listHostessTables` ran a `reservations` aggregate after seeding even though that aggregate doesn't touch `event_tables` at all; `listWaiterTables` and `listBottleOrders` each fetched table-name resolution data (`resolveReservationTableNames`) *after* their main row fetch even though neither depends on the other.
**Solution:** parallelized every one of these independent pairs/triples via `Promise.all` (see inline comments in `staff.service.ts` at each call site for the specific dependency reasoning per case - not all of them could be parallelized wholesale, some fetches do depend on the seeding having completed first).
**Measured after:** `/staff/hostess-tables` **718-1022ms** (was 1180-1650ms), `/staff/waiter/tables` **967-1204ms** (was 1616-1892ms), `/staff/bottle-orders` **719-1014ms** (was 1714-1930ms). Roughly 30-45% cut depending on endpoint and role.
**Risk:** Low - every parallelized pair was verified independent by reading what fields/tables each query actually touches (documented inline), not assumed from proximity in the code.

### 21. Venue PR-network endpoints — parallelized the existence+permission check that ran before every request, allowed or not
**Measured before fixing:** endpoints under `/venues/:id/pr-network*`, `/venues/:id/pr-dashboard`, `/venues/:id/pr-events/:eventId/assignments`, `/venues/:id/users` all cost **~470-725ms** *even when the request was ultimately rejected with 403* for a role without PR access - i.e., the authorization check itself was the expensive part, not just the data it protects.
**Root cause:** every one of these called `await this.getVenue(venueId)` (a full-row existence check) and then, sequentially, `await this.resolvePrActorContext(...)` (a second DB query for any non-owner role) - 2 full round trips paid before a 403 could even be thrown, since the second check's query is unconditional for the common "not a PR member" case.
**Solution:** added `getVenueAndPrActorContext()`, a shared helper that runs both checks via `Promise.allSettled` (not `Promise.all`, specifically to preserve the original error precedence - "venue not found" still wins over "forbidden" if both would fail, matching the prior sequential behavior exactly). Applied to `listAssignableUsersForPr`, `listVenuePrNetworkMembers`, `registerPrEntryFromScan`, `getPrDashboardStats`, and (as a 3-way variant including the event-ownership check) `listPrEventAssignments`. Also fixed `getMyPrNetworkMembership` and `getMyPrSeasonPass` the same way, plus reordered their free, synchronous role checks to run *before* any DB query at all (previously `getVenue` ran unconditionally even for requests a synchronous check would reject for free).
**Measured after:** rejected requests to these endpoints now cost either ~1ms (when the synchronous check alone is enough to reject) or ~240ms (one round trip, when a DB-backed permission check is genuinely needed) instead of ~470-725ms.
**Not touched:** `registerPrQrScan` (`POST`, live QR-scanning path) has the identical pattern but is a write endpoint under active use during events; left as-is in this pass rather than restructure a write path without a live test of the write behavior itself - flagged as a good next candidate.

### 22. `GET /venues/:id/stripe/connect/status` — stopped writing on every read
**Measured:** 975-1633ms, driven almost entirely by a live `stripe.accounts.retrieve()` call - a real external API round trip that can't be eliminated without caching (deliberately not done here - see below).
**Found while investigating:** this GET endpoint unconditionally wrote the fetched Stripe status back to the `venues` row on *every* call, even when nothing had changed since the last check.
**Solution:** only writes when the live Stripe values actually differ from what's stored.
**Not done:** caching the Stripe response itself. This endpoint's entire purpose is to reflect *live* Stripe account status (used on a venue's payment-settings screen), and it's low-traffic (checked occasionally by a venue owner, not polled) - the audit's "cache with short TTL" framework doesn't clearly help here without a deliberate invalidation story, and the write-on-every-read fix already removes the one unambiguous inefficiency.

### Still open from this round (found, not fixed)
- **`GET /venues/:id/analytics*`** (750-1300ms across venue/admin) and **`GET /admin/dashboard`** (~1060ms) - confirmed by live measurement to be exactly as expensive as the original audit predicted. Both are Priority 3 (pre-aggregation/design work), unchanged in this pass.
- **`GET /venues/:id/floor-plan`** (~720-790ms) - not previously flagged as a top offender in the code-only audit; now confirmed one of the slower endpoints live. Not investigated further in this pass (ran out of scope/time) - worth a closer look alongside the events `floor-plan`/table-pricing resolution already flagged in audit §2.
- **`RegisterDto`-class bugs in other DTOs**: fix #18 addressed the one instance actually exercised by live testing. A systematic pass checking every DTO's required/optional fields against what its service actually requires was **not** done - this write endpoint sweep (create/update paths) is the natural way to surface the rest, and wasn't run in this session (see below).
- **Write endpoints (`POST`/`PATCH`/`PUT`/`DELETE`) were not load-tested in this pass.** This session tested every `GET` endpoint across all four roles; extending that to writes means creating/mutating real rows (reservations, entries, sales, promos - the last of which fan out a push notification to every client with a push token) against the shared dev database. Given the scope already covered and the added blast radius of write testing, I stopped here rather than proceeding without explicit scoping from you on which writes are safe to exercise and clean up. Happy to do a scoped pass (e.g. a specific role's write flow, with cleanup) if you want it next.

---

## Deferred from this pass (see `PERFORMANCE_AUDIT.md` for full detail)

- Persisting resolved Stripe ticket amounts on `ticket_orders` (needs a migration + live-DB validation) and fully moving `ensureEventTablesSeeded` off the GET path (needs a design decision on trigger points) — both **Priority 2/3 boundary** items, flagged above with reasons they weren't done blind.
- Venue analytics pre-aggregation into `event_analytics_snapshots` — **Priority 3**, confirmed approach is a periodic job (not incremental on-write) per your input, but not yet implemented; needs its own design/implementation pass.
- WebSocket/SSE push channel for reservation/table-availability state — explicitly deferred per your input in favor of frontend-only `staleTime` tuning for now; no backend change made or needed for that decision.
- Token revocation store (still in-memory, doesn't survive across serverless instances/restarts), auth rate limiting, cursor pagination — **Priority 4**, intentionally not implemented (not evidenced as needed at current scale).

---

## Before / After

No load-testing environment is available in this session, so latency numbers below are **Not measured**. What changed is described qualitatively; the audit's targets (p50 < 200ms, p95 < 500ms) should be validated against real traffic/staging once deployed.

| Area | Before | After | Measured improvement |
|---|---|---|---|
| `GET /events` (list) | Up to N individual `UPDATE` statements per call (N = events with drifted status), no `take` | ≤2 batched `updateMany` calls per call | Not measured |
| Every authenticated request | Blocking DB write (`touchUserActivity`) in the request path | Fire-and-forget, off the critical path | Not measured |
| `POST /staff/hostess-tables/:id/update-entrati` | Read-modify-write race under concurrent scans | Atomic, row-locked update | Correctness fix (race eliminated), latency not measured |
| `GET /venues`, staff sales/entries lists | Unbounded `findMany` | Bounded (1000/5000 row safety caps) | Not measured (no behavior change at current volumes) |
| `GET /reservations/table-invitations/incoming` | Full-table scan of all table reservations, incl. cancelled | Filtered + capped at 2000 | Not measured |
| `POST /promos` | Blocked on push fan-out | Responds before push fan-out completes | Not measured |
| `POST /friends/requests`, `staff.recordEntry`, `admin.getDashboard`, `users.getMe`/`updateMe` | 2 sequential round-trips for independent queries | 1 round-trip (parallelized) | Not measured, ~1 round-trip saved per call by inspection |
| Prisma / validation | No global `ValidationPipe` (decorators inert in **both** entrypoints, including production) | `ValidationPipe({ transform: true })` active, now via a single shared `src/bootstrap.ts` used by both `src/main.ts` and the real production entrypoint `api/index.ts` | N/A (correctness, not perf) |
| Auth transport | Bearer-only; browser token lived only in `localStorage`, unreadable by Next.js SSR | Additive httpOnly `nighthub_session` cookie alongside the unchanged `access_token` JSON field; Bearer still fully supported (mobile unaffected) | N/A (unblocks frontend SSR; no backend latency claim) |
| `GET /events/:id` | `include: { venue: true }` — full venue row incl. Stripe/contract fields | `select` of display fields only | Not measured |
| Badge evaluation (`evaluateForUser`, `getBadgesForViewer`) | Up to 5 separate `entries.findMany` calls per pass for users with multiple time/venue/streak-based badges | 1 shared, memoized `entries.findMany` per pass | Not measured |

---

## Test plan run

- [x] `tsc --noEmit` — clean
- [x] `nest build` — clean
- [x] `eslint` on touched files — clean of new logic errors (remaining errors are pre-existing `@typescript-eslint` strictness warnings unrelated to this change, present before this session)
- [x] `jest` (unit) — 3/3 suites, 3/3 tests passing (no e2e suite was exercised against a live DB in this session)
- [ ] Manual endpoint verification against a running instance — not done in this session (no dev DB/server available here); recommend smoke-testing `GET /events`, `POST /staff/hostess-tables/:id/update-entrati`, `POST /friends/requests`, login/register (ValidationPipe), and `POST /auth/login` + a follow-up authenticated request using only the cookie (no Authorization header) before deploying.

## Required manual step before deploying this batch

Set **`CORS_ORIGINS`** (comma-separated list of the real frontend origin(s), e.g. `https://app.nighthub.it`) in every deployed environment. Without it, the CORS allow-list falls back to `localhost` only, and the deployed frontend will start failing CORS on every request after this deploy. This is the one change in this document that requires action beyond merging the code.

---

## Fourth pass (2026-08-11): closing out the remaining `ENDPOINTS_BENCHMARK.md` 🔴 items

Picked up exactly where the third pass's "Still open" list left off. Verified with `tsc --noEmit`, `nest build`, `eslint --fix` (only touched files), `jest`, then re-measured live against the same dev DB with the same 4 role accounts (multiple runs per endpoint to check stability, not a single sample).

### 23. Found the real bug behind the staff/venue vs admin gap on sales/entries lists
**Problem:** `GET /staff/entries`, `/bar-sales`, `/cloakroom-sales`, `/table-sales` cost staff/venue ~720-730ms but admin only ~478-480ms **on the same endpoint** — flagged as suspicious but not investigated in the third pass.
**Root cause:** `resolveEventIdForStaffApi` already does one `events.findUnique` to resolve/validate the `eventId`. The controller then, only for non-admin roles, called a *second*, separate `assertEventBelongsToVenue(resolvedEventId, effectiveVenueId)` — another full `events.findUnique` for the same row, just to check `venue_id`. Admin skips that second call entirely (admin isn't venue-scoped), which is exactly the ~240-250ms gap.
**Solution:** `ensureEvent`/`resolveEventId` (`staff.service.ts`) now accept an optional `expectedVenueId` and do the existence + venue-ownership check in the *same* query (`select: { id, venue_id }` instead of a full-row fetch, then compare). All 7 GET handlers in `staff.controller.ts` (entries, bar-sales, cloakroom-sales, table-sales, hostess-tables, waiter/tables, bottle-orders) now pass `expectedVenueId` instead of making a separate call afterward.
**Measured:** staff/venue dropped from ~720-730ms to ~475-580ms, now matching admin's cost on the same endpoints (uniform across roles, as it should be — same query, same data).
**Risk:** Low. Same authorization semantics: the check only actually runs in the branch where a caller-supplied `eventId` needs venue verification; the venueId/staffId-resolved branches were already implicitly venue-scoped and the old code's check there was always-true dead weight anyway.

### 24. `GET /venues/:id/pr-dashboard` and `GET /venues/:id/floor-plan` — found sequential-await bugs, not first-time optimizations
**Problem (`pr-dashboard`):** `loadPrMemberRows(venueId)` and a raw `venue_pr_qr_scans` aggregate query both ran *after* `getVenueAndPrActorContext` resolved, sequentially, even though neither depends on the actor-context result (both are only filtered by `visibleIds` afterward).
**Problem (`floor-plan`):** `getVenueFloorPlan` called `getVenue()` (existence check), then `ensureVenueFloorPlan()` (floor-plan row lookup), then a `Promise.all` of 3 more queries — 3 sequential round trips where only the last one was actually parallelized.
**Solution:** both endpoints now issue all their independent reads via a single `Promise.all` (pr-dashboard: actor-context + event-ownership check + member rows + scan aggregate, 4-way; floor-plan: venue existence + floor-plan-with-landmarks + zones + tables, 4-way, with the floor-plan's `landmarks` now fetched via a nested `include` instead of a separate query).
**Measured:** pr-dashboard 725-758ms → ~240-370ms. floor-plan 723-1089ms → ~330-350ms.
**A false start worth recording:** the first version of both fixes used `prisma.$transaction([...])` instead of `Promise.all([...])`, expecting the same 1-round-trip win. Live measurement showed **no improvement** from that version. Reason: a Prisma batch `$transaction` holds a single DB connection and executes its queries sequentially over it (one `BEGIN`/`COMMIT`, not concurrent execution) — on a remote pooled DB (Supabase pgbouncer here) the per-query network round trip dominates, so N queries in one `$transaction` still cost ~N × one-query-duration. Switching to plain `Promise.all` (each query gets its own pooled connection, all execute concurrently) is what actually produced the measured win. Applied the same correction to the `GET /events/:id` pricing/floor-plan loader (#25) and `recalculateEventStats` (#26) below. **Takeaction for future work in this codebase: `$transaction` is for atomicity, not parallelism — use `Promise.all` for independent reads that don't need snapshot isolation with each other.**

### 25. `GET /events/:id` — deduplicated the table-pricing/floor-plan query fetches
**Problem:** `buildResolvedTablePricing` and `buildDerivedFloorPlanForEvent` each independently fetched `venue_tables` and `event_tables` (the override rows) — same data, fetched twice, across two separate transactions.
**Solution:** new `loadEventPricingAndFloorPlanSource(eventId, venueId)` fetches `venue_tables`, `event_tables` overrides, the floor plan (+landmarks), and all the venue's table zones exactly once, via `Promise.all` (see #24's note on why not `$transaction`). `buildResolvedTablePricingFromSource` and `buildDerivedFloorPlanFromSource` now derive their respective outputs from this shared, already-fetched data instead of querying independently.
**Measured:** modest, non-linear improvement (~1057-1111ms baseline → ~850-1250ms). Profiling this endpoint live (temporary `console.time` instrumentation, removed before finalizing) showed the pricing/floor-plan portion dropped from ~600ms to ~150-300ms range depending on run, but the event's own primary fetch (`events.findUnique` with `venue`/`promos`/`entry_prices`) costs a separate, untouched ~500-550ms — that's now the dominant remaining cost on this endpoint and wasn't in scope for this pass.
**Risk:** Low. Same fields, same override/selection logic, just computed once from shared data instead of twice from independently-fetched (identical) data.

### 26. `recalculateEventStats` (backs `GET /events/:id/stats` and `GET /staff/events/:id/stats`) — merged existence-check into the aggregate batch, then fixed the same `$transaction`-doesn't-parallelize mistake
**Problem:** the third pass (#19) already replaced the expensive `getEvent()`-based existence check with a bare `findUnique({ select: { id: true } })`, but it still ran as a separate round trip before the 4-way aggregate `$transaction`.
**Solution:** merged the existence check into the same batch as the 4 aggregates, then (per #24's finding) switched the whole batch from `$transaction` to `Promise.all` so all 5 reads actually run concurrently instead of sequentially in one transaction.
**Measured:** `GET /events/:id/stats` and `GET /staff/events/:id/stats` dropped from 768-1061ms (third pass's already-improved number) to ~240-530ms depending on role.
**Risk:** Low-medium — on a genuinely nonexistent `eventId`, the 4 aggregates now run (and return zero sums) before the 404 is thrown, instead of failing fast on the existence check alone. Traded a small amount of wasted work on the rare 404 path for one fewer round trip on the common success path; matches the risk profile of similar trade-offs already accepted in earlier passes.

### 27. `GET /admin/users` — the users list was still sequential after the activity-aggregate batch
**Problem:** the 9-query `Promise.all` activity-aggregation batch (already parallel, good) was followed by a separate, sequential `users.findMany({ take: 50, ... })` — independent of every aggregate (only joined via id lookups in the final `.map()`), so it didn't need to wait.
**Solution:** moved the `users.findMany` into the same `Promise.all` batch as the 10th query.
**Measured:** 586ms → ~335-350ms.
**Risk:** None — verified independent by inspection (`users` table, no shared filter with the activity aggregates on `reservations`/`ticket_orders`/`entries`/`venue_stays`).

### 28. `GET /reservations` (admin, unfiltered) — added the safety-net `take` the audit flagged
**Problem:** `listReservations` (used by the admin no-filter path, and the client/venue filtered paths) had no `take` at all, unlike the sibling `findMany`s already capped in the first pass (#5).
**Solution:** added `take: 1000`, same safety-net pattern as #5, with the same heavy `select` (user/event/venue/table/zone) left untouched since it's needed by the admin ops view.
**Measured:** no visible change at current dev data volume (a handful of rows) — this is a correctness/scaling safety net for production volume, not a perf fix that shows up today. Flagging explicitly so it isn't mistaken for "didn't work": it wasn't expected to move the needle on this dataset.

### 29. `GET /venues/:id/analytics*` and `GET /admin/dashboard` — in-process TTL cache (explicitly not pre-aggregation)
**Context:** the audit (Priority 3, §6) recommends pre-aggregating into the already-present-but-unused `event_analytics_snapshots`/`event_forecasts` tables. That's a real schema/design decision (update trigger: incremental-on-write vs. periodic job) that the third pass already deferred pending your sign-off, and this session's explicit instruction was to use a short-TTL cache instead this round, not to build the pre-aggregation pipeline.
**Solution:** new `src/common/ttl-cache.ts` — a minimal in-process `Map`-backed cache with per-call generic typing (`getOrCompute<T>(key, ttlMs, compute)`) and request coalescing (concurrent calls for the same key share one in-flight compute; failures aren't cached). Wired into `VenuesService.getAnalytics`/`getAnalyticsOverview`/`getRevenueBreakdown` (keyed by `venueId`/`venueId+eventId`, 15s TTL) and `AdminService.getDashboard` (single global key, 15s TTL). `getAnalyticsDemographics` and `getAnalyticsOverview` already called the now-cached `getAnalytics`/`getRevenueBreakdown` internally, so they benefit automatically — and the cache is shared across roles/callers hitting the same venue, not per-user.
**Measured:** first hit in a 15s window costs the same as before (750-1373ms depending on endpoint/role — the underlying query cost wasn't touched); every subsequent hit within the window returns in ~1ms.
**Explicitly not done:** the actual pre-aggregation. This is a stopgap that helps polling/repeated-view patterns; it does not reduce the cost of a genuinely cold hit, and does not survive a serverless cold start or share state across instances. Still the right next step per the audit if the 15s-stale, first-hit-slow behavior isn't good enough in production.
**Risk:** Low. 15s of staleness on venue analytics/admin dashboard aggregates (not correctness-critical, not per-user, no write path involved) is well within what these views already tolerated via HTTP `s-maxage` caching in earlier passes.

### Still open after this pass
- **Pre-aggregation for analytics/admin-dashboard** (Priority 3) — deliberately not done this round, see #29.
- **`GET /events/:id`'s primary fetch** (~500-550ms for `venue`+`promos`+`entry_prices`) — now the dominant cost on this endpoint after #25; not investigated further this session.
- **`GET /staff/hostess-tables`/`waiter/tables`/`bottle-orders`** — unchanged this session; the audit's full recommendation (move `ensureEventTablesSeeded` off the GET path entirely) is still a deferred design decision, same reasoning as the third pass's #15.
- **Write endpoints** — still not load-tested (same scope boundary as the third pass).

### Test plan run (this pass)
- [x] `tsc --noEmit` — clean
- [x] `nest build` — clean
- [x] `eslint --fix` on touched files (`events.service.ts`, `venues.service.ts`, `staff.service.ts`, `staff.controller.ts`, `admin.service.ts`, `reservations.service.ts`, new `common/ttl-cache.ts`) — no new logic errors introduced (remaining `@typescript-eslint` `no-unsafe-*` warnings are pre-existing, tied to `as any` Prisma casts already present in this codebase before this session, e.g. `venue_floor_plans`/`venue_table_zones` not yet in the generated Prisma types used elsewhere)
- [x] `jest` — 3/3 suites, 3/3 tests passing
- [x] Live endpoint verification — local server against the same dev DB, all 4 role accounts, 4 separate benchmark runs per endpoint to confirm the improvements are stable and not single-sample noise (see `ENDPOINTS_BENCHMARK.md` for the full before/after table and the network-jitter caveat observed on a couple of isolated re-runs)

---

## Fifth pass (2026-08-11, same day): closing out the "Still open" items above to get every endpoint under 500ms

Explicit follow-up instruction from the fourth pass's own "Still open" list: push every remaining >500ms endpoint down, with `GET /venues/:id/stripe/connect/status` explicitly excluded (external Stripe call, not in scope - "non sono gestiti pagamenti per ora"). Same verification loop as every other pass: `tsc --noEmit`, `nest build`, `eslint --fix`, `jest`, then live re-measurement (local server, same dev DB, all 4 roles, multiple runs per endpoint).

### 30. `GET /events/:id` — collapsed the pricing/floor-plan loader into the main event fetch's `Promise.all`
**Problem:** fix #25 (fourth pass) deduplicated the pricing/floor-plan queries but they still ran as their own `Promise.all` batch *after* the main `events.findUnique` resolved, because `loadEventPricingAndFloorPlanSource(eventId, venueId)` needed `venue_id` - only known once the event row came back. Two sequential batches, ~330-340ms each, ~675ms total measured with temporary `console.time` instrumentation (removed before finalizing).
**Solution:** `loadEventPricingAndFloorPlanSource` now takes only `eventId` and filters `venue_tables`/`venue_floor_plans`/`venue_table_zones` through the `venue.events.some.id = eventId` relation instead of a direct `venue_id` equality - so it no longer needs the main event fetch to resolve first. `getEvent` now runs all 7 queries (event+venue, promos, entry_prices, and the 4-query pricing/floor-plan source) in **one** `Promise.all`. `serializeEventWithTablePricing` was renamed `serializeEventWithPricingSource` and takes the already-fetched source instead of loading it itself.
**Measured:** 1057-1250ms (fourth-pass baseline) → **~340-390ms** steady state.
**Risk:** Low - same filtered data (a table only ever belongs to one venue, and the relation filter selects the same rows the old `venue_id` equality did), verified by comparing response shape (`table_pricing`/`floor_plan` fields) before/after against the same test event.

### 31. `GET /staff/*` list endpoints — venue-scope validation no longer blocks the fetch when `eventId` is already known
**Problem:** fix #23 (fourth pass) merged the double query into one, but `resolveEventIdForStaffApi` still ran as its own `await` *before* the list call in all 7 controller handlers - a real dependency only when `eventId` needs to be resolved from `venueId`/`staffId` (rare), but paid unconditionally even when the caller already passed an explicit `eventId` (the common case, since these are polled staff-UI list views with an event already selected).
**Solution:** new private `resolveEventIdAndFetch()` helper in `StaffController`. When `eventId` is explicit, the validation (`resolveEventIdForStaffApi`, still doing its existence+ownership check) and the actual list fetch (called immediately with the known `eventId`) run in the same `Promise.all`. If validation rejects (bad venue/nonexistent event), the whole call rejects before anything is returned to the client - the only cost on that rare error path is one wasted list query. When `eventId` is *not* explicit (needs resolving), the fetch waits on the resolution via `.then()`, preserving the real dependency. Applied to all 7 GET handlers (`entries`, `bar-sales`, `cloakroom-sales`, `table-sales`, `hostess-tables`, `waiter/tables`, `bottle-orders`).
**Measured:** `entries`/`bar-sales`/`cloakroom-sales`/`table-sales` dropped from ~475-580ms (already-uniform-across-roles after fix #23) to **~240-290ms** - now matching the single-query floor instead of paying for 2 round trips.

### 32. `ensureEventTablesSeeded` — the venue-tables lookup no longer needs `venue_id` resolved first
**Problem:** this function (backing `listHostessTables`/`listWaiterTables`/`listBottleOrders`) ran `Promise.all([event existence, existingEventTables])` first, *then* `Promise.all([venueTables, grouped reservations])` - 2 sequential batches, because `venueTables` filtered by `venue_id: event.venue_id`, which only came from the first batch.
**Solution:** same relation-filter trick as #30 - `venue_tables.findMany({ where: { venue: { events: { some: { id: eventId } } } } } })` instead of `{ venue_id: event.venue_id }`. Now all 4 reads (event existence, existing event_tables, venue_tables, grouped reservations) run in **one** `Promise.all`.
**Measured:** `listHostessTables` and `listBottleOrders` dropped to **~240-290ms** (from 715-1100ms range). `listWaiterTables` improved to **~480-530ms** but stays there - its own `rows` fetch (a separate `event_tables.findMany` with nested `table_sales`/`bottle_orders`) has a genuine dependency on the seeding step's writes completing first (it reads what seeding just wrote), so it can't be folded into the same batch without risking a stale read. This is now believed to be close to the structural floor for this endpoint without moving seeding off the GET path entirely (deferred design decision, unchanged from the third pass's #15/#20).

### 33. `getAnalyticsUncached` — the 7-query aggregate batch no longer waits on the event list
**Problem:** `entries`/`reservations`/`bar_sales`/`cloakroom_sales`/`event_tables` groupBys and a raw SQL query all filtered by `event_id: { in: eventIds } }`, where `eventIds` came from a `rawEvents` fetch that had to resolve first (2 sequential batches: venue+events, then the 7-query aggregate block).
**Solution:** all five filters switched from `event_id: { in: eventIds } }` to the `event: { venue_id: venueId } }` relation filter (identical result set - `eventIds` was always exactly "this venue's events" in the first place), and the raw SQL query gained a `JOIN events ev ON ev.id = e.event_id` + `WHERE ev.venue_id = ...` instead of an `IN (...)` list built from `eventIds`. All 9 queries (venue existence, event list, and the 7 aggregates) now run in a single `Promise.all`. The `rawEvents.length === 0` early-return still exists (checked after the batch resolves) - on that rare "brand new venue" path the other 8 queries ran for nothing, a fine trade for one fewer round trip on every normal call.
**Measured:** `GET /venues/:id/analytics` 1st-hit cost dropped from ~750-1140ms (fourth-pass baseline, already cached-on-repeat) to **~595-640ms**. `GET /venues/:id/analytics/overview` often lands under 310ms now (benefits from `getRevenueBreakdown`'s cache being warmed by a concurrent/recent `getAnalytics` call in the same TTL window).
**Risk:** Low - verified the relation filter and the `IN` list produce the same event set by construction (`eventIds = rawEvents.map(e => e.id)` and `rawEvents` was already `where: { venue_id: venueId }`).

### 34. Fixed the same `$transaction`-doesn't-parallelize bug in 4 more places, plus removed several no-longer-necessary sequential `await`s on existence checks
**`getStats` (`GET /venues/:id/stats`):** was `$transaction([events.count, promos.count, reservations.count, reservations.aggregate])` - switched to `Promise.all`. Measured 475-680ms → ~240ms.
**`listVenueTables`, `listVenueStations`, `listVenueTableZones`** (`/venues/:id/tables`, `/stations`, `/table-zones`): each did `await this.getVenue(venueId)` (existence-only, result unused) *before* its own `findMany` - the check's result isn't consulted by the query, so it now runs in the same `Promise.all`. ~480-530ms → ~240ms each.
**`listAssignableUsersForPr`** (`/venues/:id/users`): same pattern - `getVenueAndPrActorContext` (auth check, throw-only) ran before the search query; now parallel. ~480-530ms → ~240ms.
**`listVenuePrNetworkMembers`** (`/venues/:id/pr-network`): `loadPrMemberRows` doesn't depend on the actor-context check (only used afterward to filter `visibleRows`) - now parallel, same pattern already applied to `getPrDashboardStats` in the fourth pass (#24). ~480-530ms → ~240ms.
**`listPrEventAssignments`** (`/venues/:id/pr-events/:id/assignments`): the 3-way `Promise.allSettled` (venue exists, event belongs to venue, actor PR access - added in the third pass's #21) still had the assignments query itself running *after* all three settled, even though the query only needs `venueId`/`eventId` (already known params), not the checks' results. Folded the query into the same `allSettled` batch as a 4th promise (manually re-implementing the settle/reject wrapper around it since `allSettled` doesn't mix typed and untyped promises cleanly - see the inline comment). ~480-530ms → ~240ms.
**Risk:** Low across all five - every case verified the "existence/auth check" promise's return value is either unused or only consulted *after* the parallel batch resolves (never used to build the other query's `where` clause), so reordering to concurrent doesn't change what gets queried, only when the error (if any) surfaces relative to the data fetch starting.

### 35. `GET /reservations` (admin, no filters) — tried splitting the 4-relation nested select into flat + batched lookups; marginal, inconsistent gain
**Problem:** `reservationSelect()` nests `user`, `event.venue`, `venue_table`, and `venue_table_zone` - even with only 3 rows in the dev DB, this consistently cost ~600-680ms (confirmed via `X-Response-Time` and cross-checked against row count - 3 rows returned, so the cost isn't row-count-driven, it's the query/join shape itself).
**Solution attempted:** new `reservationScalarSelect()` (no nested relations) + `hydrateReservations()`, which takes the flat rows and does 4 batched `findMany({ where: { id: { in: [...] } } })` lookups (users, events+venue, venue_tables, venue_table_zones) in `Promise.all`, then merges in JS. Scoped to `listReservations` only (the admin no-filter path) - `getReservation` and `listReservationsPaginated` still use the original nested `reservationSelect()`, left untouched to limit blast radius.
**Measured, with per-query instrumentation (temporary, removed before finalizing):** the flat reservations fetch reliably lands at ~240ms (the expected floor). The 4 batched lookups, launched together via `Promise.all`, do **not** reliably land together - in repeated runs, 2-3 of them finish around ~240-340ms but one (varying which one across runs) consistently finishes at ~580ms, as if queued behind the others despite being fired at the same instant. Total end-to-end: ~578-680ms, i.e. **no reliable improvement** over the original single nested-query approach, sometimes marginally better, never worse.
**Conclusion - this is a DB-side concurrency ceiling, not a code problem:** the local machine has 20 CPUs, so Prisma's default client-side connection pool (`num_cpus * 2 + 1` ≈ 41) is not the constraint. The straggler-query pattern under genuine concurrent load points at the remote Supabase pooler's (pgbouncer) own connection pool size being the limiting factor. This can't be fixed by further query restructuring - it needs either fewer concurrent queries per request (pre-aggregation, again) or a pgbouncer pool size increase (infrastructure change, outside this session's code-only scope). Kept the split version since it's a slight net positive on average and doesn't regress the worst case, but documenting clearly that this is *not* a resolved 500ms case, and further attempts at the same technique on other endpoints likely hit the same wall.
**Same root cause suspected for `GET /admin/dashboard`'s persistent ~865-1065ms 1st-hit cost** (already fully `Promise.all`-parallel, ~20 queries) - not re-investigated further this pass since #29's cache already handles the repeat-view case, and the same infrastructure-not-code conclusion applies.

### Still open after this pass
- **Pre-aggregation for analytics/admin-dashboard** (Priority 3) - the only way to reduce the cold-hit cost itself, not just deduplicate it via cache. Still deliberately not done.
- **DB connection pool sizing** (Supabase pgbouncer) - newly identified as the likely limiting factor for `GET /admin/dashboard` and `GET /reservations` (admin)'s remaining cost. Infrastructure change, not code - flagging for whoever owns the Supabase project config.
- **`GET /staff/waiter/tables`** (~480-530ms) - believed to be at the structural floor given its genuine seed-then-read dependency; moving `ensureEventTablesSeeded` off the GET path (audit's original recommendation, deferred since the first pass) is the only further lever.
- **Write endpoints** - still not load-tested (same scope boundary carried since the third pass).

### Test plan run (this pass)
- [x] `tsc --noEmit` — clean
- [x] `nest build` — clean
- [x] `eslint --fix` on touched files (`events.service.ts`, `venues.service.ts`, `staff.controller.ts`, `reservations.service.ts`) — no new logic errors; fixed one genuinely new issue (`reason` implicitly `any` in a manually-constructed `allSettled`-style handler in `listPrEventAssignments`, #34) and one dead variable (`eventIds` no longer used in `getAnalyticsUncached` after #33)
- [x] `jest` — 3/3 suites, 3/3 tests passing
- [x] Live endpoint verification — local server against the same dev DB, all 4 role accounts, multiple benchmark runs (cold-start and steady-state) per endpoint, plus targeted per-query `console.time` profiling (added and removed per fix) to diagnose the two cases that didn't fully resolve (#34's `waiter/tables`, #35's `reservations`)
