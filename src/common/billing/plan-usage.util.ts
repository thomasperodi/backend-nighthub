// Used by OrganizationsService.getUsage to compute plan overage. Previously also shared with
// AdminService's venue-plan billing, but that legacy per-venue plan concept was removed
// 2026-08-20 - organizations are now the only billing subject with a plan.

export function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (
    typeof value === 'object' &&
    value !== null &&
    'toNumber' in value &&
    typeof (value as { toNumber: () => number }).toNumber === 'function'
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function nextMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

/**
 * The billing month containing `now`, on the venue calendar (Europe/Rome, not the server's
 * clock: at 00:30 on the 1st in Italy it is still the previous month in UTC, and a server in
 * another timezone would shift the bounds). Bounds are UTC midnights, directly comparable
 * with events.date (@db.Date).
 */
export function billingMonth(
  now: Date = new Date(),
  timeZone = process.env.EVENTS_TIMEZONE || 'Europe/Rome',
) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value) - 1;
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
}

export type PlanCustomTerms = {
  monthly_price?: number;
  included_events?: number | null;
  included_people?: number | null;
  extra_event_price?: number;
  extra_person_price?: number;
} | null;

// Merges a plan's own price/quotas with a negotiated override (if any) - an override wins
// field-by-field when present. For a custom plan (is_custom, no defaults of its own) every
// field effectively comes from the override.
export function resolvePlanTerms(
  plan: {
    monthly_price: unknown;
    included_events: number | null;
    included_people: number | null;
    extra_event_price: unknown;
    extra_person_price: unknown;
  } | null,
  customTerms: PlanCustomTerms,
) {
  const monthlyPrice =
    customTerms?.monthly_price ??
    (plan?.monthly_price == null ? null : toNumber(plan.monthly_price));
  const includedEvents =
    customTerms?.included_events ?? plan?.included_events ?? null;
  const includedPeople =
    customTerms?.included_people ?? plan?.included_people ?? null;
  const extraEventPrice =
    customTerms?.extra_event_price ??
    (plan?.extra_event_price == null ? 0 : toNumber(plan.extra_event_price));
  const extraPersonPrice =
    customTerms?.extra_person_price ??
    (plan?.extra_person_price == null ? 0 : toNumber(plan.extra_person_price));

  return {
    monthlyPrice,
    includedEvents,
    includedPeople,
    extraEventPrice,
    extraPersonPrice,
  };
}

// `null` includedEvents/includedPeople means nothing to meter (no plan assigned, or a
// custom/Elite plan with no quota set) - no overage.
export function computeOverage(
  terms: {
    includedEvents: number | null;
    includedPeople: number | null;
    extraEventPrice: number;
    extraPersonPrice: number;
  },
  eventsCount: number,
  peopleCount: number,
) {
  const extraEventsCount =
    terms.includedEvents == null
      ? 0
      : Math.max(0, eventsCount - terms.includedEvents);
  const extraPeopleCount =
    terms.includedPeople == null
      ? 0
      : Math.max(0, peopleCount - terms.includedPeople);

  const extraEventsCost =
    Math.round(extraEventsCount * terms.extraEventPrice * 100) / 100;
  const extraPeopleCost =
    Math.round(extraPeopleCount * terms.extraPersonPrice * 100) / 100;

  return {
    includedEvents: terms.includedEvents,
    includedPeople: terms.includedPeople,
    extraEventsCount,
    extraPeopleCount,
    extraEventsCost,
    extraPeopleCost,
    overageCost: Math.round((extraEventsCost + extraPeopleCost) * 100) / 100,
  };
}
