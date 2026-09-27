# NightHub Backend-API — Architecture Notes

> Generated from a full-repo audit on 2026-08-18. This file is a reference for future sessions — re-verify against the code before relying on specifics, especially line numbers, as the codebase evolves. Companion frontend repo: `C:\Users\perod\Desktop\nightApp\pwa\nighthub` (see its own CLAUDE.md).

## Stack & shape

NestJS 10 + Prisma (PostgreSQL), deployed serverless on Vercel. `src/` is a flat, one-module-per-feature layout (`Controller → Service → PrismaService`, no repository/CQRS abstraction). No `organizations` module exists anywhere — **the tenant/ownership boundary is `venues`**, not an Organization entity. Keep this in mind before assuming any "Organization ↔ Venue ↔ PR" model exists; it doesn't yet.

Global request pipeline (`app.module.ts`): `ThrottlerGuard` → `JwtAuthGuard` → `RolesGuard`, applied to every route by default. Opt out with `@Public()`.

## Domain model as it actually exists today

- **User** (`users`): single global `role: client|staff|venue|admin` enum + optional `venue_id` FK (pins `staff`/`venue` accounts to exactly one venue — via a plain column, not a join table, so one staff account = one venue, ever).
- **Venue** (`venues`): the top-level tenant. Owns events, tables/zones, staff/venue users (via `users.venue_id`), PR memberships, pricing, Stripe Connect fields, subscription plan.
- **PR** = `venue_pr_memberships`: per-venue, per-user row with a 2-tier hierarchy role (`responsabile > pr`, simplified from 3-tier `capo_squadra` on 2026-08-18 — see migration `20260818170000_remove_capo_squadra_role`) via self-referencing `parent_membership_id`. `@@unique([venue_id, user_id])` — one membership per user per venue, but a user CAN hold separate memberships at multiple venues. PR-ness is a *derived* login-time overlay (`AuthService.resolvePrDisplayContext`) — the stored `users.role` stays `client`; there's no `pr` value in the `RolesGuard` enum. Related: `venue_pr_event_assignments` (N:N PR↔Event), `venue_pr_qr_scans` (referral scan log), `venue_pr_membership_passes` (1:1 Apple Wallet season pass). `organization_id` (nullable FK, added 2026-08-18): a PR invited by an Organization is exclusive to it (the venue neither sees nor manages it, see `VenuesService.listVenuePrNetworkMembers`'s filtering and the new `create/update/deleteOrganizationPrMember` methods) — venue-side invites can no longer set this field at all (2026-08-19).
- **Event** `organization_id` (nullable FK, added 2026-08-19): set when an Organization — not the venue — created the event at one of its linked venues (`organization_venue_links`). Both the venue and the creating organization can manage it afterwards (no exclusivity, confirmed decision) — `EventsController` accepts an `organization`-role caller on create/update/cancel/remove, validating `venue_id` against the organization's links on create and never letting a non-admin move `venue_id` afterwards.
- **Event**: `venue_id` required N:1 — one venue only, no cross-venue/org-level events. `is_featured` is admin/cron-gated, never venue-settable.
- **Reservation**: `type: table|entry`, `status: pending|confirmed|cancelled|completed`. Entry reservations auto-confirm; table reservations start `pending`. **Cancellation is always soft-delete** (status flip), never a hard delete. Clients can only cancel their own `table` reservations (entry reservations are not client-cancellable by design). Full rules in §9 of the audit below.
- **Friendship**: `friend_requests` (pending/accepted/rejected) + `friendships` (2 rows per accepted pair). **No "cancel my own outgoing request" endpoint exists** — only accept/reject by the recipient.
- **Referral**: no dedicated table. Implemented via PR `ref_code` resolved at reservation-create time from `meta`, plus `venue_pr_qr_scans` for door-side QR scanning. No `/r/:code` redirect controller server-side (that lives in the frontend).
- **Push**: dual-channel via `PushDispatchService` — Expo (single `users.push_token` column, one device) + Web Push (`push_subscriptions`, true multi-device, keyed by unique `endpoint`).
- **Wallet/Pass**: only the PR season pass has real Apple Wallet (`passkit-generator`, `.pkpass`) integration; Google Wallet is a URL-template env var only, no real API integration. No wallet pass exists for ordinary event tickets/reservations (those just get a locally-scannable `qr_token`).
- **Stripe**: schema has full scaffolding (`venues.stripe_account_id`, `ticket_orders` with session/payment-intent fields) but **zero implementation code** — no `stripe` package usage anywhere in `src/`. Payments are not wired up despite the schema suggesting otherwise.

## Auth

JWT access token (~15 min) + DB-backed rotating refresh token (httpOnly cookie only, never JS-readable). `CsrfOriginGuard` on `/auth/refresh|logout|sessions*`. Password reset: dual-provider (Supabase-managed or legacy self-issued JWT with single-use enforcement via a DB unique-constraint on `jti` — race-safe, not check-then-act). `changePassword` revokes all other sessions; the forgot/reset flow does **not**.

## Security posture (see full audit for detail)

Ownership/tenant checks are done **manually, per-endpoint**, not via a reusable guard — pattern repeated ~20+ times: `if (user.role === 'venue' && user.venue_id !== id) throw Forbidden`. Verified present and correct on venue stats/analytics/pricing/tables/zones/floor-plan/stations, and on events/reservations/staff via `assertEventBelongsToVenue`-style helpers. **PR-network endpoints are the highest-risk area**: controllers declare `@Roles('client','staff','venue','admin')` (effectively "any authenticated user") and push all real authorization into `VenuesService.resolvePrActorContext`/`getVenueAndPrActorContext` — correct today, but a new PR endpoint that forgets to call this helper would be wide open. **Recommendation for any future work here: extract a reusable `@RequireVenueOwnership()` guard/decorator instead of continuing to copy-paste the check.**

## OpenAPI document (added 2026-08-18)

`@nestjs/swagger` is wired in `src/bootstrap.ts` and its CLI plugin is enabled in `nest-cli.json` (auto-infers schemas from DTO classes, no `@ApiProperty()` decorators needed anywhere). The spec is served at `GET /api/docs-json` (Swagger UI at `/api/docs`) in every environment, since the frontend's `npm run generate:api-types` script needs to fetch it. If you add a DTO with an inline anonymous object/array-of-object property, extract it into a named class (see `src/events/dto/event-nested.dto.ts` for the pattern) — the schema builder throws a "circular dependency" error on unnamed nested object types, which is exactly the bug this fix addressed in `CreateEventDto`/`UpdateEventDto`.

## Organizations (added 2026-08-18)

Implemented per confirmed business decisions (see the audit artifact / memory). New tables: `organizations` (name, vat_number, is_active, no owner-membership table — one owner account per org for now), `organization_venue_links` (N:N, admin-created only). New FK: `venue_pr_memberships.organization_id` (nullable, one org per PR membership). New `UserRole` value `organization`, mirroring `venue`'s pattern exactly: `users.organization_id` + `role: 'organization'` for an org's own login account. JWT payload/`RequestUser` now carries `organization_id` alongside `venue_id`.

New module `src/organizations/` (`OrganizationsController`/`OrganizationsService`) — admin-only CRUD + venue-linking, org-self endpoints (`/organizations/me`, `/venues`, `/pr-network`, `/stats`). Authorization is centralized in one `assertOrgAccess`/`assertAdmin` pair inside the service (not copy-pasted per-endpoint) — this was a deliberate fix for the IDOR-risk pattern flagged elsewhere in this codebase, see §D.2 of the audit.

`VenuesService`'s PR-network methods (`createVenuePrNetworkMember`/`updateVenuePrNetworkMember`/`listVenuePrNetworkMembers`) now accept/return `organization_id` — only the venue owner (not team managers) can tag a PR with an organization, and only if `organization_venue_links` actually has that pairing (`assertOrganizationLinkedToVenue`). New venue-side endpoints: `GET /venues/:id/organizations` (linked orgs) and `GET /venues/:id/organizations/:orgId/stats` (that org's performance, scoped to this venue's own events only — entries/scans carry `venue_id` directly, so the scoping is structural, not an extra filter someone could forget).

Unlinking an org from a venue (`OrganizationsService.unlinkVenue`) only deletes the link row. Organization PR memberships have no `venue_id` of their own (one row per organization, covering every linked venue), so they are **not** deactivated: they simply stop covering that venue and keep working the others. (An earlier version soft-deactivated them; that is no longer true.)

**Fase 5 gap-closing (added 2026-08-18, same day)**: three items flagged as missing from the original Fase 5 pass were built:
- **Reusable ownership guards**: `src/common/guards/venue-ownership.guard.ts` (`@RequireVenueOwnership()`) and `organization-ownership.guard.ts` (`@RequireOrganizationOwnership()`) — applied to every Organizations-related endpoint (`OrganizationsController`'s `:id`-scoped routes, `venues.controller.ts`'s new `/organizations` routes). The service layer no longer re-checks ownership for those routes (removed the redundant `assertOrgAccess`/inline role checks) — this is what closes the "guard centralizzata" recommendation from the audit. **Not retrofitted**: the ~20+ pre-existing copy-pasted ownership checks elsewhere in `venues.controller.ts`/`events.controller.ts`/`reservations.controller.ts`/`staff.controller.ts` — the guard is available for that but retrofitting all of them is a separate, larger pass.
- **Push test endpoint**: `POST /auth/push-test` — authenticated, sends a test push to the calling user's own devices only (Expo + every Web Push subscription via `PushDispatchService`), throttled 5/min. Cannot target anyone else.
- **Organization billing**: `organizations.plan_id` (FK to `subscription_plans`) + `PATCH /organizations/:id/plan` (admin-only). Confirmed decision: billing lives on organizations, one flat plan per org regardless of venue count. **Update 2026-08-20**: the legacy per-venue equivalent (`venues.plan_id`/`plan_custom_terms`, `PATCH /admin/venues/:id/plan`, and all venue-side "clienti analizzati"/overage metering in `AdminService`) has been removed entirely — organizations are now the only billing subject with a plan. `venues.contract_*` (flat contract fee, separate concept) is untouched.

**Still not built**: UI/endpoint for a request-to-venue flow when a client wants to cancel an already-confirmed table reservation (client just gets a blocking message today). Multi-owner organizations and multi-org-per-PR remain out of scope per the confirmed decisions (not gaps, deliberate).

## Custom wallet cards / Fase 7 (added 2026-08-18)

Per-venue PR season pass branding, requested explicitly and implemented same-day. New `venue_wallet_templates` table (1:1 with `venues`: `logo_path`, `background_color`, `foreground_color`, `label_color`) — additive, a venue without a row gets the exact same hardcoded dark/gold pass as before. `buildPrSeasonPassApplePkpass` in `VenuesService` is now `async` (needed to fetch the logo bytes) and reads the template when present. New `SupabaseStorageService.downloadPublicImageBuffer` fetches an uploaded image's bytes via the Supabase client (not the public URL) for embedding directly into the generated `.pkpass`; new `'venue-wallet-logos'` storage prefix. New venue-owned endpoints (`GET/PATCH /venues/:id/wallet-template`, `POST/DELETE /venues/:id/wallet-template/logo`) — first endpoints in this controller to use `@RequireVenueOwnership()` instead of the inline check the rest of the file still uses. `icon.png`/`icon@2x/3x.png` stay the minimal placeholder regardless of branding (Apple requires a specific small square size; uploaded logos aren't resized) — only `logo.png` uses the venue's asset. Google Wallet remains out of scope (no real API integration, URL-template only, as before).

## Cross-tenant security verification (2026-08-18)

Ran a one-off QA script (Prisma-seeded test data + real logins via `POST /auth/login` + HTTP requests against a locally running instance, then fully cleaned up — not committed, not part of the test suite) covering 14 cross-tenant access checks across 2 venues and 2 organizations: a `venue` account cannot read another venue's linked organizations, wallet template, or org-scoped stats; an `organization` account cannot read another organization's detail, stats, venues, or PR network; unauthenticated requests are rejected. **14/14 passed.** This exercised `VenueOwnershipGuard`/`OrganizationOwnershipGuard` end-to-end, not just at the unit/boot level. If you need to re-verify after changing ownership logic, the script pattern (seed via Prisma directly, login via the real endpoint, assert status codes, delete everything in a `finally`) is straightforward to recreate — it wasn't kept in the repo since it's a one-off verification, not a maintained test.

## Known gaps relevant to planned frontend work

- No cancel-own-friend-request endpoint.
- No Organization entity/module at all — multi-org-per-venue and multi-venue-per-org (from the product brief) require net-new schema + module work, not a refactor.
- No server-side deep-link/redirect handling for referrals.
- Stripe/payments not implemented despite schema support.

For the full line-cited audit (endpoints tables, migration history, every model's fields), see the conversation history of the 2026-08-18 audit, or re-run an Explore-agent pass over `src/` and `prisma/schema.prisma` — this file intentionally summarizes rather than reproduces that level of detail so it stays maintainable.

## Organization & PR rework (2026-09-27)

Domain rules and official metrics: `docs/spec/01-domain/pr-network.md` (source of truth). Key points for this codebase:

- **Official PR metrics** live in `src/common/pr/pr-metrics.util.ts` (`referral_reservations`, `referral_guests`, `attributed_entries`, `conversion_rate`, `scans`, plus `rollupTeamCounters` for `team_*`). `VenuesService.queryPrCounters({ venueIds?, eventIds?, membershipIds?, from?, to?, bucket })` computes them in **one** SQL round trip for any set of memberships, grouped by venue / event / nothing. Every consumer (venue PR dashboard, organization stats, PR guests/history) goes through it — don't add a second definition of "ingressi portati".
- **Venue PR rows vs organization PR rows**: `loadPrMemberRowsForVenue(venueId)` returns both (venue rows + rows of organizations linked to the venue). Use it whenever the question is "who works at venue X". The `venue` role must still filter out `organization_id` rows (exclusivity). `loadPrMemberRows(venueId)` (venue rows only) is kept for venue-only callers.
- **Membership resolution for org PRs**: never `loadPrMembershipById(venueId, …)` (venue_id-only). Use `resolveScannablePrMembership(venueId, { id })` and `loadPrHierarchyRowsForActor` for subtree checks.
- **Check-in attribution**: `ReservationsService.checkInEntryReservationByQr` copies `reservation.meta.pr_membership_id` onto every `entries` row it creates (validated UUID + existing membership). Historic data: `npm run backfill:pr-entries` (dry run, prints the count) then `npm run backfill:pr-entries -- --apply`. Idempotent (only `pr_membership_id IS NULL`).
- **Never wipe history**: `assertPrMembershipDeletable` → 409 `{ code: 'HAS_TEAM' | 'HAS_HISTORY' }` on both venue and organization deletes; `assertRoleChangeKeepsHierarchy` → 409 `HAS_TEAM` on responsabile → pr with children. One organization per PR: 409 `OTHER_ORGANIZATION` / `IN_NETWORK` on create.
- **Season pass per venue**: migration `20260927120000_pr_season_pass_per_venue` replaces `@unique(pr_membership_id)` with `@@unique([venue_id, pr_membership_id])` (relation renamed `season_passes`). The door scanner resolves by `qr_token` and rejects a pass of another venue. `GET /venues/:id/pr-network/me/season-pass` also returns `template` (venue branding).
- **Event status is time-driven** (`EventsService.computeEffectiveStatus`): `DRAFT` = scheduled, `LIVE` = happening now, `CLOSED` = over. "Upcoming" = `DRAFT | LIVE` from the current night (06:00 rollover, `currentNightDate()` in `pr-network.service.ts`).

New endpoints (all behind `@Roles` + `RequireOrganizationOwnership` or the PR subtree checks in `PrNetworkService`):

| Endpoint | Notes |
|---|---|
| `GET /organizations/:id/stats?venue_id&from&to` | official metrics: totals, `by_venue`, `by_member` (with `team_*`). `by_venue.active_pr_count` removed |
| `GET /organizations/:id/pr-network?include=stats&from&to` | + `parent`, `team_count`, `stats`, `team_stats` |
| `GET /organizations/:id/pr-network/:memberId` | profile, metrics, per venue, last 8 nights, assigned events |
| `GET /organizations/:id/pr-network/lookup` | + `status: available / in_network / other_organization`, `avatar` |
| `POST /organizations/:id/pr-network/:memberId/regenerate-code` | new `ref_code`; old links stop attributing |
| `GET/PUT /organizations/:id/events/:eventId/pr-assignments` | PUT body `{ membership_ids }` (full set) or `{ all_active: true }`; never deletes rows |
| `GET /organizations/:id/events` | + `list_count`, `entries_count`, `pr_assigned_count`, `referral_reservations`, `attributed_entries` |
| `GET /organizations/:id/usage` | + `terms` (unit prices; estimates only, no in-app payment) |
| `GET /venues/:id/pr-dashboard` | official metrics in `totals`/`stats`/`team_stats` (`entries` kept as alias), `actor_membership_id` |
| `GET /venues/:id/pr-dashboard/guests?eventId&membershipId&scope=team` | name + avatar only, never email/phone |
| `GET /venues/:id/pr-dashboard/history?limit&membershipId&scope` | last N nights, bookings vs entries |
| `GET /venues/pr-network/me` | + `source`, `organization_id/name`, `parent` |
| `GET /pr-network/me/events?past` | events of every venue the PR works (direct + organization) |
| `GET/POST /pr-network/me/team`, `GET /pr-network/me/team/lookup`, `PATCH /pr-network/me/team/:memberId` | responsabile's own team; org responsabile → org row, venue responsabile → venue row; PATCH only `is_active`, only own subtree |

Tests: `src/venues/venues.pr-network.spec.ts`, `src/venues/pr-network.service.spec.ts`, `src/organizations/organizations.pr-stats.spec.ts`, `src/reservations/reservations.pr-attribution.spec.ts`.
