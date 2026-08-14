# NightHub Backend — Performance Audit

Date: 2026-08-11
Scope: `backend-api` (NestJS + Prisma + PostgreSQL), read-only audit. No code changed in this phase.
Method: manual review of `prisma/schema.prisma`, `main.ts`, `app.module.ts`, guards, and every controller/service in `src/*`, cross-checked against actual migration SQL (not assumed) for every indexing claim.

---

## 1. Executive Summary

**Current state.** The schema is unusually well-indexed for a project this size — almost every hot `WHERE`/`ORDER BY` combination already has a composite index, and several correct partial-unique indexes exist to prevent double-booking. The codebase is consistent in using `select` over `include` in most list endpoints and already batches independent queries with `Promise.all` in many places. This is not a neglected backend — it's a large, feature-rich one (14.5k lines across services) that has grown a set of specific, fixable hot spots rather than systemic bad practice.

**Main problems, in order of real-world impact:**

1. **Read endpoints that perform writes.** `GET /events` updates DB rows (event status) on every call; `GET /staff/hostess-tables` and siblings run a full reconciliation (reads + `createMany` + `$transaction` of updates) on every poll. This is the single biggest source of unpredictable p95/p99 latency and unnecessary write load.
2. **One endpoint (`GET /venues/:id/analytics`) recomputes venue-wide analytics in application code** by loading every event, every entry, and every reservation for the venue's entire history, on every request. This is the most expensive single endpoint in the codebase and the clearest case for pre-aggregation.
3. **An external-API N+1**: `GET /payments/venue/transactions` calls the Stripe API 2–3 times per row for up to 100 rows — up to ~300 sequential HTTP calls to a third party on one request.
4. **Badge evaluation re-runs the full criteria engine (multiple sequential DB queries per badge) synchronously inside user-facing write paths** (e.g. accepting a friend request evaluates all badges for *two* users before responding).
5. **Every authenticated request pays a blocking DB round-trip** for activity-tracking (`touchUserActivity`, awaited in `JwtAuthGuard`), and **no global `ValidationPipe` is registered**, so `class-validator` decorators present on some DTOs are dead code.
6. Several **bulk admin write endpoints** (bulk table/station creation) loop `await` per row instead of batching, which is slow but low-frequency (admin-only), so lower priority than the above.

**Quick wins (safe, no contract change, high impact):**
- Stop writing inside `GET /events` (batch the status sync or drop write-on-read entirely).
- Add pagination `take` to a dozen unbounded `findMany()` calls on append-only tables.
- Register a global `ValidationPipe` (whitelist + transform) — closes a real validation/security gap, not just perf.
- Make `touchUserActivity` fire-and-forget instead of `await`-blocking every request.
- Parallelize a handful of independent sequential `await` pairs.

**Structural problems (need design work, not a quick patch):**
- Venue analytics needs pre-aggregation (the schema already has unused `event_analytics_snapshots`/`event_forecasts` tables that look purpose-built for exactly this and aren't populated by any code path found).
- Badge evaluation needs restructuring so it doesn't scan `entries` once per badge per action.
- `ensureEventTablesSeeded` reconciliation needs to move from "every GET" to "on write, once."

**Corrections to my own initial hypotheses:** Two suspected race conditions (table double-booking, duplicate table-number assignment) turned out to be **already prevented** by partial unique indexes I verified directly in the migration SQL — see §7. I'm flagging this explicitly because it's the kind of false positive that's easy to introduce if "fixed" a second time unnecessarily.

---

## 2. API Performance — Endpoint-by-Endpoint Findings

Format: `METHOD PATH — Controller/Service — Problem — Priority`

### Events
| Endpoint | Problem | Priority |
|---|---|---|
| `GET /events` | `EventsController` → `EventsService.listEvents` (events.service.ts:1052). No `take` on the main `findMany`; every returned row whose computed status differs from stored status triggers an individual `UPDATE events` via `Promise.all` (events.service.ts:1176-1180, 1118-1122). A read endpoint performs unbounded writes. | **CRITICAL** |
| `GET /events?page=&pageSize=` | `listEventsPaginated` exists and is correctly paginated (events.service.ts:1208) but is only used when the client explicitly passes `page`/`pageSize` — the unpaginated path above is still reachable and is likely the default from older frontend clients. | HIGH |
| `GET /events/:id` | `getEvent` → `serializeEventWithTablePricing` fires 2 extra `$transaction`s (up to 6 additional queries: table pricing resolution + derived floor plan) on every single call, plus `include: { venue: true }` pulls the entire `venues` row (Stripe fields, price lists, contract fields) when the event detail view needs a handful. | MEDIUM |
| `GET /events/:id/stats` | `recalculateEventStats` first calls `getEvent()` (the full 6-query chain above) purely to check existence, then runs its own 4-query aggregate `$transaction`. | LOW |
| `venueStats` (service method) | Loops `Promise.all(events.map(e => getEventStats(e.id)))` — N × (full getEvent chain + 4 aggregates) instead of one `groupBy`. | MEDIUM |
| Bulk table pricing (`POST/PATCH /events`) | `applyTablePricingOverrides` loops `for (const row of rows) await tx.event_tables.update/create` sequentially instead of `updateMany`/`createMany`. | MEDIUM |

### Venues
| Endpoint | Problem | Priority |
|---|---|---|
| `GET /venues` | `listVenues()` — `findMany()` with **no `where`, no `take`, no `select`** — full unbounded table scan of every column (including Stripe secrets-adjacent fields, price-list JSON) (venues.service.ts:1379). | **CRITICAL** |
| `GET /venues/:id/analytics` | `getAnalytics` — loads all events for the venue, then all `entries` and all `reservations` for every one of those events (both with nested `user` include, no `take`), then does gender/age/weekday/lead-time/repeat-customer aggregation in JS on every request. Cache-Control is `s-maxage=10`, i.e. effectively uncached for a per-tenant expensive computation. | **CRITICAL** |
| `GET /venues/:id/analytics/demographics` | Internally calls the *entire* `getAnalytics()` above just to extract two fields. | HIGH |
| `GET /venues/:id/analytics/overview` | Runs its own 5-query fan-out plus a full `getRevenueBreakdown` (6 more queries incl. a raw `UNION ALL` across 4 sales tables), uncached, likely polled by staff dashboards. | MEDIUM |
| `POST /venues/:id/tables` (bulk) | `createVenueTablesBulk` loops per table doing up to 4 sequential awaited queries (count, upsert zone, findFirst, update/create) inside one open transaction — up to ~1200 round trips for a 300-row bulk import. | MEDIUM |
| `POST /venues/:id/stations` (bulk) | Same pattern, smaller scale (≤50 rows → ≤100 round trips). | MEDIUM |
| `GET /venues/:id/floor-plan` | 3 parallel `findMany` (good — not sequential) but none use `select`; minor over-fetch, mitigated by 90s cache header. | LOW |
| Internal `getVenue()` | Used as an existence-check guard from dozens of call sites, always fetches the full row (incl. Stripe/price-list JSON) with no lightweight `select: { id: true }` variant. | LOW |
| PR dashboard / QR scan registration | `loadPrMemberRows(venueId)` (full membership+user join for the whole venue) is re-run from scratch on every scan/assignment call instead of being reused within a request or cached briefly. | LOW |

### Reservations / Staff / Venue-Stays / Payments
| Endpoint | Problem | Priority |
|---|---|---|
| `GET /payments/venue/transactions` | `listVenueTransactions` calls the **Stripe API** 2–3 times per order row (`resolveTicketAmountCentsForOrder`, `resolveTicketRefundedCents`) for up to 100 rows inside `Promise.all` — up to ~300 external HTTP calls per request, unbounded latency, exposed to Stripe rate limits. | **CRITICAL** |
| `GET /reservations/table-invitations/incoming` | `listIncomingTableInvitations` — `findMany({ where: { type: 'table' } })` with **no user filter and no `take`** — fetches every table reservation system-wide, then filters in JS by scanning a JSON `meta` field for invites addressed to the caller. | HIGH |
| `GET /staff/entries`, `/staff/bar-sales`, `/staff/cloakroom-sales`, `/staff/table-sales` | All four `findMany` with no `take`, scoped only by `event_id` — returns full history of an append-only table on every poll. | HIGH |
| `GET /staff/hostess-tables`, `/staff/waiter/tables`, `/staff/bottle-orders` | `ensureEventTablesSeeded` runs a full read-reconcile-write pass (multiple reads + conditional `createMany`/`$transaction` of updates) at the **top of every GET call**, not just on first access or on write. Staff UIs typically poll these. | HIGH |
| `GET /reservations` (admin, no page params) | Falls back to unbounded `listReservations` instead of forcing pagination, with a heavy nested `select` (user, event+venue, table, zone). | MEDIUM |
| `POST /staff/hostess-tables/:id/update-entrati` | Read-modify-write (`table.entrati + delta` computed in app code, then plain `update`) instead of an atomic Prisma `increment` — genuine lost-update race under concurrent door scans. | HIGH |
| `POST /reservations/scan-entry-qr` | `checked_in_at` is checked **before** the `$transaction` that creates the `entries` row, not inside it — two concurrent scans of the same QR can both pass the guard and both create an entry (no unique constraint ties one `entries` row to one reservation). | MEDIUM |
| `POST .../pr-membership-passes/scan` | Same before-transaction dedupe-check pattern for season-pass scans. | MEDIUM |
| `recordEntry`/`recordSale`/`addTablePayment`/`createTableBottleOrder` | Each synchronously recomputes full event stats (`recalculateEventStats`) as part of the write's critical path, and `recordSale` calls `resolveEventId` twice (redundant lookup). | MEDIUM |
| `createReservation` | Sequential `await` for `events.findUnique` then `users.findUnique` — independent, could be `Promise.all`. Also does a redundant pre-check `findFirst` for the same-user/same-event/same-type conflict that a working partial-unique index already enforces (safe, just an extra round trip). | LOW |
| `listWaiterTables` | Embeds up to 50 `table_sales` + 20 `bottle_orders` per table row in a list view. | LOW |

### Friends / Badges / Users / Admin / Promos
| Endpoint | Problem | Priority |
|---|---|---|
| `POST /friends/requests/:id/accept` | Triggers `evaluateBadges` **twice** (once per user), each doing a sequential `for...of` loop over every active badge with an `await` DB query per badge — several of those queries (`distinct_venues_count`, `weekend_streak`, `event_before_time/after_time`, `seasonal_window`) independently re-fetch the user's entire `entries` history instead of sharing one fetch. All of this sits in the accept-request response path. | **CRITICAL** |
| `GET /badges/user/:userId` | `getBadgesForViewer` fires one query burst (`Promise.all`) per active badge on every profile-badges view — concurrent rather than sequential, but still redundantly re-scans the same `entries` rows per criteria type. | HIGH |
| `GET /friends/map`, `GET /friends` | Both run an **unbounded `venues.findMany`** (every venue with lat/long, no `take`) on every call just to do client-side nearest-venue matching in JS. Likely polled for "live" features. | HIGH |
| `GET /friends/map` vs `GET /friends` | Near-duplicate query sets (friendships → friend rows → open venue_stays → all venues) implemented independently in two service methods with no shared caching. | MEDIUM |
| `GET /friends/search` | `currentUserFriendIds` used in a mutual-friends lookup has no `take` — a user with thousands of friends sends an unbounded `IN (...)` list on every search keystroke. | MEDIUM |
| `POST /friends/requests` | Sequential independent existence checks (`friendships.findFirst`, then `friend_requests.findFirst`) that could run in `Promise.all`. | LOW |
| `GET /admin/dashboard` | ~20 queries batched in `Promise.all` (good) but 2 more `groupBy` calls execute **after** that block resolves despite being independent of its output — should join the same `Promise.all`. | MEDIUM |
| `GET /admin/users` | Site-wide 30-day activity aggregation (9 queries across `reservations`/`ticket_orders`/`entries`/`venue_stays`) scans full history regardless of the fact the final result is capped to 50 users. | LOW |
| `POST /promos` (create) | `sendPromoCreatedPush` loads all client users with a push token (unbounded `findMany`) and is `await`ed — **blocks the HTTP response** to the admin/venue creating the promo on a full push fan-out. | MEDIUM |
| `GET /promos`, `by-event`, `by-venue`, `public/active` | None paginated; the controller already accepts and silently discards `page`/`pageSize` query params (`void page; void pageSize;`) — pagination was clearly planned but never wired up. | LOW |
| `GET /users/me`, `PATCH /users/me` | `resolvePrDisplayContext` runs one extra query unconditionally for every role, sequentially after the main user fetch rather than in parallel, even for users who can never have a PR membership. | LOW |

---

## 3. Prisma Analysis

**N+1 patterns (query-per-row-in-a-loop):**
- `events.listEvents`/`listEventsPaginated`: N status-sync `UPDATE`s per list call (§2).
- `venues.createVenueTablesBulk` / `createVenueStationsBulk`: N×(3–4) sequential queries per bulk row.
- `events.applyTablePricingOverrides`: N sequential update/create per pricing row.
- `payments.listVenueTransactions`: N×2–3 **external Stripe calls** per row (worst offender — not even a DB query, a third-party HTTP round trip).
- `badges.evaluateForUser`: N sequential DB queries, one per badge, with several of those independently re-querying the same `entries` rows.

**Duplicate/repeated queries within one logical request:**
- `badges.service.ts`: `distinct_venues_count`, `event_before_time`, `event_after_time`, `seasonal_window`, `weekend_streak` each independently `findMany` the user's `entries` — four+ separate fetches of overlapping data that could be one shared fetch.
- `staff.recordSale`: calls `resolveEventId` twice for the same logical event.
- `friends.listFriends` vs `friends.getMapPresence`: near-identical query sets duplicated across two methods.

**Unbounded `findMany()` (no `take`) — full list, verified by file:line:**
- `venues.service.ts:1379` `listVenues`
- `venues.service.ts:1606` `listEvents` (dead/duplicate of events.listEvents, still reachable)
- `events.service.ts:1130` `listEvents` default path
- `reservations.service.ts:1892` `listIncomingTableInvitations`
- `staff.service.ts` `listEntries`/`listBarSales`/`listCloakroomSales`/`listTableSales`
- `friends.service.ts:414, 706` venues lookups in map/list
- `friends.service.ts` `listRequests`, `listGroups`, `listGroupTableProposals`
- `promos.service.ts` `listPromos`/`listByEvent`/`listByVenue`/active-list variants
- `admin.service.ts` `getUsers` activity-scan sub-queries (bounded final result, unbounded intermediate scans)

**`skip`/offset pagination risk:** the paginated endpoints that exist (`listEventsPaginated`, admin lists) use `skip`/`take` (offset pagination), which is fine at current data volumes. None of the append-only high-volume tables (`entries`, `bar_sales`, `venue_pr_qr_scans`) are offset-paginated in any endpoint today because most access to them is scoped by `event_id`/`venue_id` and unbounded rather than paginated at all — the real problem is the missing `take`, not the pagination *style*. Recommend adding bounded `take` first; only move to cursor pagination if/when a single venue/event's row count in these tables is observed to exceed a few thousand.

**Queries that could be aggregated instead of computed in JS:**
- `venues.getAnalytics` (age/gender/weekday/lead-time histograms) — candidates for SQL `GROUP BY`/`FILTER` or, better, pre-aggregation (§6).
- `badges` criteria engine — several criteria (`distinct_venues_count`, streaks) could be single aggregate queries instead of fetching raw rows and reducing in JS.

**Sequential awaits that are safe to parallelize (independent data):**
- `reservations.createReservation`: `events.findUnique` + `users.findUnique`.
- `staff.recordEntry`: `users.findUnique` (push token) + `events.findUnique` (venue geofence fields).
- `friends.sendRequest`: `friendships.findFirst` + `friend_requests.findFirst`.
- `admin.getDashboard`: the two trailing `groupBy` calls vs. the main `Promise.all`.
- `users.getMe`/`updateMe`: user fetch + `resolvePrDisplayContext`.

**Transactions:** no evidence of transactions held open across unrelated work or long-running external calls. The bulk-loop transactions (§2, venues bulk create) are the one case where a transaction is open far longer than necessary (up to ~1200 sequential statements) — this is a lock-contention/timeout risk on concurrent admin edits, not a correctness bug.

---

## 4. Database Analysis

**Overall:** the schema is well ahead of the code in index hygiene. Every FK-heavy table has purposeful composite indexes matching real query shapes (e.g. `entries` has `[event_id, created_at]`, `[event_id, age_bucket, created_at]`, `[event_id, station_id, created_at]` — clearly modeled around actual staff-dashboard filters, not guessed). I did **not** find missing indexes for any `WHERE`+`ORDER BY` combination actually used in the code I reviewed.

**Verified-correct constraints that a first pass could wrongly "fix" a second time (do not touch):**
- `reservations_unique_active_table_event_idx` — partial unique index on `(event_id, venue_table_id) WHERE type='table' AND status<>'cancelled' AND venue_table_id IS NOT NULL`, added in migration `20260519140000_add_venue_floor_plan_and_table_zones`. This already prevents the same table being double-booked at the DB layer; application code additionally pre-checks with a `findFirst` (redundant extra read, not a race).
- `event_tables_event_id_assigned_number_unique` — partial unique index on `(event_id, assigned_number) WHERE assigned_number IS NOT NULL`, added in migration `20260226153000_add_event_tables_assigned_number`. Same story for hostess table-number assignment.
- `reservations_unique_active_user_event_type_idx` — unique per `(user_id, event_id, type) WHERE status<>'cancelled'`, migration `20260810120000_reservation_unique_per_type`. Prevents a user double-booking the same event/type.

**Genuine gaps found:**
- No DB-level protection against the **entrati counter lost-update** (`staff.service.ts` read-modify-write) — this isn't an indexing problem, it needs an atomic `UPDATE ... SET entrati = entrati + $delta` (Prisma `increment`), not a new index.
- No uniqueness constraint tying one `entries` row to one `reservations.id` for QR check-in — a concurrent double-scan can create two `entries` rows. Consider adding `checkin_entry_id` as the sole write path with a unique constraint, or wrapping the check inside the transaction with `SELECT ... FOR UPDATE`.
- `event_analytics_snapshots` and `event_forecasts` exist in the schema with exactly the shape needed to fix the analytics hotspot (§6) but no service code writes to them — they appear to be unused/aspirational tables from earlier planning. Worth confirming with the team before building on them (they might be intended for a different pipeline, e.g. a data/ML job).

**Redundant indexes:** none found — the schema doesn't have overlapping/superseded composite indexes.

**Candidates for `EXPLAIN ANALYZE` once a review environment is available** (not run in this audit — no DB access):
- `venues.getAnalytics`'s underlying `entries`/`reservations` `findMany` for a high-volume venue.
- `payments` raw `UNION ALL` revenue breakdown query.
- `venue_pr_qr_scans` GROUP BY in `getPrDashboardStats` under a large PR network.

---

## 5. API Payload Analysis

Endpoints returning materially more than the frontend likely needs:

| Endpoint | Over-fetches | Suggested trim |
|---|---|---|
| `GET /venues` | Every column of every venue (Stripe account id/charges/payouts flags, contract fields, full `bar_price_list`/`bottle_price_list` JSON) | `select` a public-safe subset (id, name, city, address, image, lat/long) for the public listing; keep full row only on `GET /venues/:id` for owner/admin roles |
| `GET /events/:id` | `include: { venue: true }` — full venue row including Stripe/contract fields | `select` only the venue fields actually rendered (name, city, image, lat/long, radius_geofence) |
| `GET /venues/:id/floor-plan` | Full columns on tables/zones/landmarks | `select` fields the floor-plan renderer uses |
| `GET /friend-groups/:id/table-proposals` | Every proposal ever created for the group, each with nested votes+users, no filter/limit | Default to open/recent proposals, add `take` |
| `GET /staff/waiter/tables` | Up to 50 sales + 20 bottle orders embedded per table row | Return current totals only in the list view; move full history behind a per-table detail endpoint |
| `GET /reservations` (admin) | Full nested `select` (user, event+venue, table, zone) with no pagination | Enforce `take`/`page` server-side regardless of query params |

None of these require a breaking contract change if implemented as `select` narrowing — the response shape stays the same, just fewer/no extraneous fields, **except** the friend-groups/table-proposals default filter and the waiter-tables trim, which change what's included by default and should be confirmed against actual frontend usage before shipping.

---

## 6. Caching Analysis

No caching layer exists today (no Redis, no `@nestjs/cache-manager`, no in-memory cache abstraction — only HTTP `Cache-Control`/`Server-Timing` headers set ad hoc per controller, which only help if there's a CDN/proxy in front of Vercel honoring them for authenticated+per-tenant responses, which is unlikely for most of these).

| Data | Classification | Notes |
|---|---|---|
| `GET /venues` public listing | SAFE TO CACHE | Changes infrequently; short in-process TTL (30–60s) cache keyed by no params is enough. |
| `GET /events/:id` table pricing + derived floor plan | CACHE WITH SHORT TTL | Only changes on admin edits to tables/zones/pricing; invalidate on those writes or use a 30–60s TTL. |
| `GET /venues/:id/analytics*` | CACHE WITH SHORT TTL, but the real fix is pre-aggregation, not caching a slow query | A cache papers over the cost for repeated hits but the first hit per TTL window is still a multi-thousand-row scan; prefer writing to `event_analytics_snapshots` incrementally (on entry/sale/reservation writes, or via periodic snapshot) and reading from that table instead. |
| Badge catalog (`badges` table, rarely changes) | SAFE TO CACHE | Small, changes only via admin/seed script — cache the catalog in-process, invalidate on admin write. |
| Per-user badge progress | DO NOT CACHE (as-is) | Depends on live user activity; instead fix the query pattern (§3), don't cache a wrong/stale answer. |
| `GET /friends/map`, `/friends/tonight` | DO NOT CACHE across users (per-user, location-sensitive) | Fix the "fetch all venues" pattern instead (geo-bound the query); a venues-with-coordinates lookup *could* be cached separately with a short TTL since venues rarely move. |
| JWT-derived `venue_id` fallback lookup in `JwtAuthGuard` | SAFE TO CACHE briefly | Only hit for tokens issued before `venue_id` was added to the payload; low volume, low priority. |

**Recommendation:** don't introduce Redis. A simple in-process TTL cache (e.g. a small `Map`-based helper or `@nestjs/cache-manager` with the default in-memory store) is sufficient for a single-region Vercel/Node deployment at this scale, for the "SAFE TO CACHE" and "SHORT TTL" rows above. The analytics endpoint is the one place where caching alone is insufficient — it needs the pre-aggregation table to actually reduce work, not just deduplicate it.

---

## 7. Concurrency Analysis

**Already safe (verified against migration SQL, not assumed):**
- Table double-booking — protected by `reservations_unique_active_table_event_idx`.
- Duplicate hostess table-number assignment — protected by `event_tables_event_id_assigned_number_unique`.
- User double-booking same event/type — protected by `reservations_unique_active_user_event_type_idx`.
All three are backed by app-level `catch` blocks that translate the resulting Postgres unique-violation into a clean 4xx, so the "pre-check `findFirst` then write" pattern in the service layer is a latency nit (one extra read per booking), not a correctness bug.

**Genuinely unprotected (real findings):**
- `staff.service.ts` `updateHostessTableEntrati` — read-modify-write on `entrati`, no atomic increment, no row lock. **Fix:** use `prisma.event_tables.update({ data: { entrati: { increment: delta } } })`.
- `reservations.checkInEntryReservationByQr` and the PR season-pass scan equivalent — the "already checked in" / "already scanned" guard reads `checked_in_at`/scan history **before** entering the `$transaction` that writes the entry. Two near-simultaneous scans of the same QR can both pass. **Fix:** move the guard read inside the transaction (or re-check right before the write, inside the same transaction, under default READ COMMITTED that's sufficient since the write itself becomes the serialization point) — or add a unique constraint if the domain allows "at most one entry per reservation."

**Where `Promise.all` is correctly used today:** venue analytics query fan-out, admin dashboard's main aggregate batch, floor-plan's 3-way fetch, most friend/badge list endpoints. No case found where independent queries were incorrectly parallelized in a way that overloads the DB (e.g. no unbounded `Promise.all` over a large per-row array hitting Postgres — the only unbounded per-row `Promise.all` found targets the **Stripe API**, not the DB, which is arguably worse for latency, not for DB load).

**Where sequential `await` should become `Promise.all`:** see the list in §3 — all are independent-data cases with no risk in parallelizing.

---

## 8. Security/Performance Analysis

- **No global `ValidationPipe`.** Verified: `main.ts`/`app.module.ts` never call `app.useGlobalPipes(new ValidationPipe(...))`, and no controller uses `@UsePipes` individually. Some DTOs (`LoginDto`, others) carry `class-validator` decorators that are never executed — malformed/extra fields pass straight through to Prisma calls. This is a correctness and security gap (no whitelist-stripping of unexpected fields, no type coercion, error responses come from Prisma/runtime exceptions instead of clean validation 400s) as much as a performance one, since it means invalid requests can travel further into the stack (more DB round trips, worse errors) before failing.
- **`JwtAuthGuard` awaits a DB write on every authenticated request.** `touchUserActivity` is `await`ed inside `canActivate` (jwt-auth.guard.ts:116) for every single API call, even though the method's own logic already throttles the actual write to once per 60s per user — the throttle check itself still requires a DB round trip on every call (an `updateMany` with a `WHERE` that may match 0 rows). Since the code already treats this as best-effort (swallows transient connectivity errors), it should not block the response.
- **Token revocation is a process-local in-memory `Set`** (`auth.service.ts:31`, explicitly commented "for demo... use Redis or DB-backed store for production"). On Vercel serverless, this means a logout on one instance does not revoke the token on any other warm instance, and is lost entirely on cold start. This is a security correctness gap, not a perf one — flagging because fixing it (e.g. DB-backed short blacklist, or shortening JWT TTL + refresh tokens) is a design decision, not a quick patch.
- **Guards are otherwise cheap and correctly ordered** — `RolesGuard` does no I/O (pure reflection + string compare), `JwtAuthGuard`'s JWT verification is synchronous/local (no network call), and it only falls back to a DB lookup for `venue_id` on old tokens missing that claim (acceptable, low-volume).
- **No rate limiting** anywhere (`@nestjs/throttler` not installed). `POST /auth/login`, `/auth/register`, `/auth/forgot-password` have no request throttling — a brute-force/enumeration risk more than a perf one, but relevant since forgot-password already deliberately avoids user enumeration in its response shape (good), undermined if there's no rate limit on it.
- **Body size limits are set explicitly and reasonably** (`main.ts`: 5MB JSON limit, with images meant to go through signed-upload URLs per the code comments) — no obvious DoS vector via oversized payloads found.
- **Logging:** no evidence of passwords, JWTs, or full tokens being logged. Some `console.log` debug blocks in `events.service.ts` are gated behind an explicit debug flag (`isDebugEventsEnabled()`), which is good practice; recommend confirming that flag defaults to off in production.
- **Error handling:** no global `ExceptionFilter` exists — Nest's default exception handling is relied on throughout. This is *not* leaking stack traces in production (Nest's default filter already redacts internals for non-`HttpException` errors), but it also means there's no consistent error envelope, no request-id/correlation-id in error responses, and Prisma errors (`PrismaClientKnownRequestError` etc.) are handled ad hoc per-service with `try/catch` rather than centrally — inconsistent, and means new endpoints have to remember to do this themselves.

---

## Priority Roadmap (for Phase 8 implementation)

### Priority 1 — Quick Wins (safe, non-breaking, do first)
1. Add global `ValidationPipe({ whitelist: true, transform: true })`.
2. Stop the write-on-read in `GET /events` (§2) — batch via `updateMany({ where: { id: { in: idsNeedingUpdate } } })` per distinct target status, or drop the write entirely if a scheduled job/DB view can compute status instead.
3. Make `touchUserActivity` fire-and-forget in `JwtAuthGuard` (don't `await` it in the request path).
4. Add `take` limits to the unbounded `findMany()` calls listed in §3 (venues list, staff sales/entries lists, incoming table invitations, promos lists, friends/venues lookup).
5. Fix `updateHostessTableEntrati` to use Prisma's atomic `increment`.
6. Parallelize the independent sequential `await` pairs listed in §3.
7. Make `sendPromoCreatedPush` fire-and-forget (don't block `POST /promos`'s response on the push fan-out).

### Priority 2 — Query Optimization
1. Trim `include: { venue: true }` on `GET /events/:id` to a `select`.
2. Deduplicate the badge criteria engine's repeated `entries` fetches into one shared fetch per evaluation pass.
3. Fix `payments.listVenueTransactions`'s per-row Stripe N+1 (batch via Stripe's list/expand APIs where possible, or cache resolved amounts on the `ticket_orders` row after first resolution).
4. Batch the bulk table/station creation loops (`createVenueTablesBulk`, `createVenueStationsBulk`) into pre-fetch + `createMany`/`updateMany`.
5. Move `ensureEventTablesSeeded` off the GET-request hot path (run on event creation/table changes, not on every list poll).

### Priority 3 — Architecture
1. Pre-aggregate venue analytics into `event_analytics_snapshots` (already in the schema, unused) instead of computing from raw `entries`/`reservations` on every request; requires deciding the update trigger (on-write incremental vs. periodic job) — **needs your sign-off before implementation, this is the one genuinely structural change in this list.**
2. Introduce a lightweight in-process TTL cache for the "SAFE TO CACHE" items in §6.
3. Centralize error handling with a global `ExceptionFilter` for consistent envelopes + Prisma error mapping.
4. Move QR check-in / season-pass scan duplicate-check inside the transaction that performs the write.

### Priority 4 — Future Scaling (not implemented now)
1. DB-backed (or Redis-backed) token revocation if multi-instance logout correctness becomes a real requirement.
2. Rate limiting on auth endpoints (`@nestjs/throttler`) if abuse is observed.
3. Cursor pagination for append-only tables, if/when a single venue/event's row counts in `entries`/`bar_sales`/`venue_pr_qr_scans` are observed to exceed a few thousand rows (not currently evidenced as a problem — offset pagination is fine at today's scale).

---

## Next Step

This audit is complete. Per the ground rules for this work, I have not modified any code yet. Priority 1 items above are safe, non-breaking, and I can proceed with them autonomously. Priority 2 items are also non-breaking but touch more surface area, so I'll batch them with visible before/after review. Priority 3 items (especially the analytics pre-aggregation) involve a design decision and should be confirmed before I start.
