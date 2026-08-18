# NightHub Backend-API — Architecture Notes

> Generated from a full-repo audit on 2026-08-18. This file is a reference for future sessions — re-verify against the code before relying on specifics, especially line numbers, as the codebase evolves. Companion frontend repo: `C:\Users\perod\Desktop\nightApp\pwa\nighthub` (see its own CLAUDE.md).

## Stack & shape

NestJS 10 + Prisma (PostgreSQL), deployed serverless on Vercel. `src/` is a flat, one-module-per-feature layout (`Controller → Service → PrismaService`, no repository/CQRS abstraction). No `organizations` module exists anywhere — **the tenant/ownership boundary is `venues`**, not an Organization entity. Keep this in mind before assuming any "Organization ↔ Venue ↔ PR" model exists; it doesn't yet.

Global request pipeline (`app.module.ts`): `ThrottlerGuard` → `JwtAuthGuard` → `RolesGuard`, applied to every route by default. Opt out with `@Public()`.

## Domain model as it actually exists today

- **User** (`users`): single global `role: client|staff|venue|admin` enum + optional `venue_id` FK (pins `staff`/`venue` accounts to exactly one venue — via a plain column, not a join table, so one staff account = one venue, ever).
- **Venue** (`venues`): the top-level tenant. Owns events, tables/zones, staff/venue users (via `users.venue_id`), PR memberships, pricing, Stripe Connect fields, subscription plan.
- **PR** = `venue_pr_memberships`: per-venue, per-user row with a 3-tier hierarchy role (`responsabile > capo_squadra > pr`) via self-referencing `parent_membership_id`. `@@unique([venue_id, user_id])` — one membership per user per venue, but a user CAN hold separate memberships at multiple venues. PR-ness is a *derived* login-time overlay (`AuthService.resolvePrDisplayContext`) — the stored `users.role` stays `client`; there's no `pr` value in the `RolesGuard` enum. Related: `venue_pr_event_assignments` (N:N PR↔Event), `venue_pr_qr_scans` (referral scan log), `venue_pr_membership_passes` (1:1 Apple Wallet season pass).
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

Unlinking an org from a venue (`OrganizationsService.unlinkVenue`) soft-deactivates (`is_active: false`, never deletes) any PR memberships that org held at that venue — confirmed rule: a PR is scoped through the venue link, so losing the link loses that venue too, for now.

**Fase 5 gap-closing (added 2026-08-18, same day)**: three items flagged as missing from the original Fase 5 pass were built:
- **Reusable ownership guards**: `src/common/guards/venue-ownership.guard.ts` (`@RequireVenueOwnership()`) and `organization-ownership.guard.ts` (`@RequireOrganizationOwnership()`) — applied to every Organizations-related endpoint (`OrganizationsController`'s `:id`-scoped routes, `venues.controller.ts`'s new `/organizations` routes). The service layer no longer re-checks ownership for those routes (removed the redundant `assertOrgAccess`/inline role checks) — this is what closes the "guard centralizzata" recommendation from the audit. **Not retrofitted**: the ~20+ pre-existing copy-pasted ownership checks elsewhere in `venues.controller.ts`/`events.controller.ts`/`reservations.controller.ts`/`staff.controller.ts` — the guard is available for that but retrofitting all of them is a separate, larger pass.
- **Push test endpoint**: `POST /auth/push-test` — authenticated, sends a test push to the calling user's own devices only (Expo + every Web Push subscription via `PushDispatchService`), throttled 5/min. Cannot target anyone else.
- **Organization billing**: `organizations.plan_id` (FK to `subscription_plans`, same catalog venues use) + `PATCH /organizations/:id/plan` (admin-only). Confirmed decision: billing moves to organizations, one flat plan per org regardless of venue count. `venues.plan_id` is **not** migrated or dropped — left in place and documented as legacy in the schema, since existing venue plan assignments in production shouldn't be silently destroyed by this change.

**Still not built**: UI/endpoint for a request-to-venue flow when a client wants to cancel an already-confirmed table reservation (client just gets a blocking message today). Multi-owner organizations and multi-org-per-PR remain out of scope per the confirmed decisions (not gaps, deliberate).

## Known gaps relevant to planned frontend work

- No cancel-own-friend-request endpoint.
- No Organization entity/module at all — multi-org-per-venue and multi-venue-per-org (from the product brief) require net-new schema + module work, not a refactor.
- No server-side deep-link/redirect handling for referrals.
- Stripe/payments not implemented despite schema support.

For the full line-cited audit (endpoints tables, migration history, every model's fields), see the conversation history of the 2026-08-18 audit, or re-run an Explore-agent pass over `src/` and `prisma/schema.prisma` — this file intentionally summarizes rather than reproduces that level of detail so it stays maintainable.
