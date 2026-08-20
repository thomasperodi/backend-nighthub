// Shared by AdminService (venue billing detail/dashboard totals) and OrganizationsService
// (organization plan-usage endpoint) - moved here so both compute overage the same way
// instead of maintaining two copies. Behavior unchanged from AdminService's original
// resolvePlanTerms/computeOverage.

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
    (plan?.extra_person_price == null
      ? 0
      : toNumber(plan.extra_person_price));

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
