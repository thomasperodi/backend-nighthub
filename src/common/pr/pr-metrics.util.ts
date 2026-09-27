// Official PR metrics (docs/spec/01-domain/pr-network.md) - one shape, same names in backend,
// frontend and design, so the venue dashboard, the organization dashboard and the PR's own
// dashboard can never drift apart on what "ingressi portati" or "conversione" means.
//
// - referral_reservations: non-cancelled reservations whose meta.pr_membership_id is the PR
// - referral_guests: sum of `guests` over those same reservations
// - attributed_entries: `entries` rows carrying the PR's pr_membership_id
// - conversion_rate: attributed_entries / referral_guests (0 when nobody booked)
// - scans: venue_pr_qr_scans rows (secondary metric)

export interface PrMetrics {
  referral_reservations: number;
  referral_guests: number;
  attributed_entries: number;
  conversion_rate: number;
  scans: number;
}

export type PrCounters = Omit<PrMetrics, 'conversion_rate'>;

export function emptyPrCounters(): PrCounters {
  return {
    referral_reservations: 0,
    referral_guests: 0,
    attributed_entries: 0,
    scans: 0,
  };
}

export function addPrCounters(target: PrCounters, source: PrCounters) {
  target.referral_reservations += source.referral_reservations;
  target.referral_guests += source.referral_guests;
  target.attributed_entries += source.attributed_entries;
  target.scans += source.scans;
  return target;
}

export function conversionRate(
  attributedEntries: number,
  referralGuests: number,
): number {
  if (!referralGuests) return 0;
  return Math.round((attributedEntries / referralGuests) * 1000) / 1000;
}

export function toPrMetrics(counters: PrCounters): PrMetrics {
  return {
    ...counters,
    conversion_rate: conversionRate(
      counters.attributed_entries,
      counters.referral_guests,
    ),
  };
}

/** Raw aggregate rows, one per (membership, bucket) - `bucket` is whatever the caller grouped
 * by besides the membership (venue_id, event_id, or a constant for plain totals). */
export interface PrCounterRow {
  pr_membership_id: string | null;
  bucket: string | null;
  referral_reservations?: number | bigint | null;
  referral_guests?: number | bigint | null;
  attributed_entries?: number | bigint | null;
  scans?: number | bigint | null;
}

/** Folds counter rows into `Map<membershipId, Map<bucket, PrCounters>>`. */
export function foldPrCounterRows(
  rows: PrCounterRow[],
): Map<string, Map<string, PrCounters>> {
  const out = new Map<string, Map<string, PrCounters>>();
  for (const row of rows) {
    if (!row.pr_membership_id) continue;
    const bucket = row.bucket ?? '';
    const byBucket =
      out.get(row.pr_membership_id) ?? new Map<string, PrCounters>();
    const counters = byBucket.get(bucket) ?? emptyPrCounters();
    counters.referral_reservations += Number(row.referral_reservations ?? 0);
    counters.referral_guests += Number(row.referral_guests ?? 0);
    counters.attributed_entries += Number(row.attributed_entries ?? 0);
    counters.scans += Number(row.scans ?? 0);
    byBucket.set(bucket, counters);
    out.set(row.pr_membership_id, byBucket);
  }
  return out;
}

export function sumBuckets(
  byBucket: Map<string, PrCounters> | undefined,
  onlyBucket?: string,
): PrCounters {
  const total = emptyPrCounters();
  if (!byBucket) return total;
  for (const [bucket, counters] of byBucket) {
    if (onlyBucket !== undefined && bucket !== onlyBucket) continue;
    addPrCounters(total, counters);
  }
  return total;
}

/**
 * team_* = own + every descendant's own. With the two-level hierarchy this is just
 * "responsabile + its PRs", but it walks the tree so a stale deeper row can't be silently
 * dropped from the totals.
 */
export function rollupTeamCounters(
  members: Array<{ id: string; parent_membership_id: string | null }>,
  own: (id: string) => PrCounters,
): Map<string, PrCounters> {
  const ids = new Set(members.map((m) => m.id));
  const children = new Map<string, string[]>();
  for (const m of members) {
    if (!m.parent_membership_id || !ids.has(m.parent_membership_id)) continue;
    const list = children.get(m.parent_membership_id) ?? [];
    list.push(m.id);
    children.set(m.parent_membership_id, list);
  }

  const cache = new Map<string, PrCounters>();
  const visit = (id: string, path: Set<string>): PrCounters => {
    const cached = cache.get(id);
    if (cached) return cached;
    const total = addPrCounters(emptyPrCounters(), own(id));
    path.add(id);
    for (const child of children.get(id) ?? []) {
      if (path.has(child)) continue; // corrupted cycle - never loop forever
      addPrCounters(total, visit(child, path));
    }
    path.delete(id);
    cache.set(id, total);
    return total;
  };

  for (const m of members) visit(m.id, new Set());
  return cache;
}
