import { Injectable, NotFoundException } from '@nestjs/common';
import { ForecastType, Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MODEL_VERSION = 'moving-average-v4';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const MIN_SAMPLE_FOR_CONFIDENCE = 3;
const MAX_SAME_WEEKDAY_SAMPLE = 12;
const MAX_SAME_VENUE_SAMPLE = 20;
const MAX_GLOBAL_SAMPLE = 50;
// A registered user's own show-up rate is trusted over the venue/global average only once
// they have this many past `entry` reservations to derive it from - below that a couple of
// no-shows or a couple of lucky check-ins would swing their "personal rate" wildly. Guest
// reservations (no user_id, no persistent identity across events) never get a personal rate
// at all and always fall back to the venue/global average, by product decision 2026-08-19.
const MIN_PERSONAL_SAMPLES = 3;
// Used only when there is truly zero historical data anywhere (brand new venue) - a
// deliberately conservative placeholder, not a claim of real predictive power (reflected in
// the very low confidence_score attached to it).
const DEFAULT_SHOW_UP_RATE = 0.7;
// Optional cutoff on how far back historical samples can reach, in days. Disabled (null) by
// product decision 2026-08-19: for now the cascade is bounded purely by event *count*
// (MAX_SAME_VENUE_SAMPLE / MAX_GLOBAL_SAMPLE), not by calendar age. Set a number here to also
// exclude samples older than N days once there's enough volume to judge if that's needed.
const HISTORICAL_LOOKBACK_DAYS: number | null = null;
// Unlike the cascade above, a user's own personal-rate history (getPersonalRates) has no
// event-count cap at all - a loyal regular can accumulate years of reservations, all reread on
// every forecast they appear in. This bound exists for two reasons, not one: query cost (an
// unbounded per-user scan doesn't stay cheap forever), and relevance (how someone behaved two
// years ago is a weaker signal than last season) - deliberately separate from, and not tied to,
// the monthly "clienti analizzati" billing count in OrganizationsService.getUsage, which resets
// every month for a completely different reason (metering, not statistics) and must keep
// reading full personal history regardless of this cutoff. Product decision 2026-08-20.
const PERSONAL_RATE_LOOKBACK_DAYS = 365;

type HistoricalEventStats = {
  guestsInList: number;
  checkedInFromList: number;
  totalEntries: number;
};

type HistoricalAggregate = {
  rate: number;
  rateStddev: number | null;
  avgWalkins: number;
  walkinsStddev: number | null;
  usableSampleSize: number;
};

export type AttendanceForecast = {
  event_id: string;
  people_in_list: number;
  predicted_from_list: number;
  expected_walkins: number;
  predicted_value: number;
  lower_bound: number;
  upper_bound: number;
  confidence_score: number;
  /** Effective blended rate for this event's list: `predicted_from_list / people_in_list`. */
  show_up_rate: number;
  /** Fraction (0-1) of `people_in_list` covered by a personal per-user rate rather than the
   * venue/global average - how much of the number above is "we know this person" vs "typical
   * night here". */
  personalized_share: number;
  sample_size: number;
  sample_basis: 'venue_weekday' | 'venue_any_day' | 'global' | 'default';
  generated_at: string;
};

type ListReservation = { user_id: string | null; guests: number };

/**
 * Simple statistical attendance forecast (no ML): predicted attendance for an event sums, per
 * person currently on the door list, that person's own historical show-up rate when they have
 * enough past `entry` reservations to trust one (see MIN_PERSONAL_SAMPLES) - otherwise the
 * venue/comparable-night average is used for them, same as before personalization existed. On
 * top of that, the historical average of walk-ins (people who enter without ever having a list
 * reservation) is added. People without an account (guest reservations, no user_id) never get a
 * personal rate but still feed the venue/global averages exactly like anyone else, and still
 * feed the walk-in average when they enter without a reservation at all. Falls back to a wider,
 * less specific comparison pool when there isn't enough venue history yet, reflected in a lower
 * confidence_score rather than hidden. Table reservations never enter this calculation - only
 * the door list (`type: 'entry'`) is in scope.
 */
@Injectable()
export class AttendanceForecastService {
  constructor(private readonly prisma: PrismaService) {}

  private async getListReservations(eventId: string): Promise<ListReservation[]> {
    return this.prisma.reservations.findMany({
      where: {
        event_id: eventId,
        type: 'entry',
        status: ReservationStatus.confirmed,
      },
      select: { user_id: true, guests: true },
    });
  }

  /**
   * A registered user's own reliability: of their past `entry` reservations at any venue in the
   * last PERSONAL_RATE_LOOKBACK_DAYS (excluding the event being forecast, and only ones for
   * events strictly before it), what fraction actually resulted in a check-in
   * (`checkin_entry_id` set)? This is reservation-level, not guest-count-weighted - it answers
   * "does Luca's own list entry usually happen", not "how many friends does Luca usually bring".
   */
  private async getPersonalRates(
    userIds: string[],
    excludeEventId: string,
    beforeDate: Date,
  ): Promise<Map<string, number>> {
    const rates = new Map<string, number>();
    if (!userIds.length) return rates;

    const rows = await this.prisma.reservations.findMany({
      where: {
        user_id: { in: userIds },
        type: 'entry',
        event_id: { not: excludeEventId },
        status: { in: [ReservationStatus.confirmed, ReservationStatus.completed] },
        event: {
          date: {
            lt: beforeDate,
            ...this.lookbackFilter(beforeDate, PERSONAL_RATE_LOOKBACK_DAYS),
          },
        },
      },
      select: { user_id: true, checkin_entry_id: true },
    });

    const totals = new Map<string, { total: number; checkedIn: number }>();
    for (const row of rows) {
      const userId = row.user_id as string;
      const t = totals.get(userId) ?? { total: 0, checkedIn: 0 };
      t.total += 1;
      if (row.checkin_entry_id) t.checkedIn += 1;
      totals.set(userId, t);
    }

    for (const [userId, t] of totals) {
      if (t.total >= MIN_PERSONAL_SAMPLES) {
        rates.set(userId, t.checkedIn / t.total);
      }
    }

    return rates;
  }

  private lookbackFilter(
    eventDate: Date,
    days: number | null,
  ): { gte: Date } | Record<string, never> {
    if (days === null) return {};
    const cutoff = new Date(eventDate);
    cutoff.setDate(cutoff.getDate() - days);
    return { gte: cutoff };
  }

  /**
   * For each historical event: how many people were on the list, how many of those were
   * actually checked in (via `reservations.checkin_entry_id`, set only by a real list scan -
   * see ReservationsService.checkInEntryReservationByQr), and how many physical entries exist
   * in total. `totalEntries - checkedInFromList` gives walk-ins without relying on
   * `entries.method`, which conflates "scanned from the list" with "staff looked the person up
   * manually" (see staff.service.ts recordEntry) and would otherwise pollute both numbers.
   */
  private async loadHistoricalStats(
    eventIds: string[],
  ): Promise<Map<string, HistoricalEventStats>> {
    const stats = new Map<string, HistoricalEventStats>();
    if (!eventIds.length) return stats;

    for (const id of eventIds) {
      stats.set(id, { guestsInList: 0, checkedInFromList: 0, totalEntries: 0 });
    }

    const [reservationRows, entryCounts] = await Promise.all([
      this.prisma.reservations.findMany({
        where: { event_id: { in: eventIds }, type: 'entry' },
        select: {
          event_id: true,
          status: true,
          guests: true,
          actual_guests: true,
          checkin_entry_id: true,
        },
      }),
      this.prisma.entries.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds } },
        _count: { _all: true },
      }),
    ]);

    for (const row of reservationRows) {
      const s = stats.get(row.event_id);
      if (!s) continue;
      if (
        row.status === ReservationStatus.confirmed ||
        row.status === ReservationStatus.completed
      ) {
        s.guestsInList += row.guests;
      }
      if (row.checkin_entry_id) {
        s.checkedInFromList += row.actual_guests ?? row.guests;
      }
    }
    for (const row of entryCounts) {
      const s = stats.get(row.event_id);
      if (s) s.totalEntries = row._count._all;
    }

    return stats;
  }

  private aggregateHistoricalStats(samples: HistoricalEventStats[]): HistoricalAggregate {
    const usable = samples.filter((s) => s.guestsInList > 0);
    if (!usable.length) {
      return {
        rate: DEFAULT_SHOW_UP_RATE,
        rateStddev: null,
        avgWalkins: 0,
        walkinsStddev: null,
        usableSampleSize: 0,
      };
    }

    const totalGuests = usable.reduce((sum, s) => sum + s.guestsInList, 0);
    const totalCheckedIn = usable.reduce((sum, s) => sum + s.checkedInFromList, 0);
    const rate = totalGuests > 0 ? totalCheckedIn / totalGuests : DEFAULT_SHOW_UP_RATE;

    const walkins = usable.map((s) => Math.max(0, s.totalEntries - s.checkedInFromList));
    const avgWalkins = walkins.reduce((sum, w) => sum + w, 0) / walkins.length;

    if (usable.length < 2) {
      return {
        rate,
        rateStddev: null,
        avgWalkins,
        walkinsStddev: null,
        usableSampleSize: usable.length,
      };
    }

    const ratios = usable.map((s) => s.checkedInFromList / s.guestsInList);
    const meanRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    const rateVariance =
      ratios.reduce((sum, r) => sum + (r - meanRatio) ** 2, 0) / ratios.length;

    const walkinsVariance =
      walkins.reduce((sum, w) => sum + (w - avgWalkins) ** 2, 0) / walkins.length;

    return {
      rate,
      rateStddev: Math.sqrt(rateVariance),
      avgWalkins,
      walkinsStddev: Math.sqrt(walkinsVariance),
      usableSampleSize: usable.length,
    };
  }

  private confidenceFor(sampleSize: number, basis: AttendanceForecast['sample_basis']): number {
    if (basis === 'default') return 0.1;
    const base = basis === 'venue_weekday' ? 0.55 : basis === 'venue_any_day' ? 0.4 : 0.3;
    const bonus = Math.min(0.35, sampleSize * 0.05);
    return Math.min(0.9, base + bonus);
  }

  private async computeHistoricalForecastInputs(
    venueId: string,
    eventDate: Date,
  ): Promise<
    HistoricalAggregate & {
      basis: AttendanceForecast['sample_basis'];
    }
  > {
    const weekday = eventDate.getUTCDay();
    const lookback = this.lookbackFilter(eventDate, HISTORICAL_LOOKBACK_DAYS);

    const pastEventsAtVenue = await this.prisma.events.findMany({
      where: { venue_id: venueId, date: { lt: eventDate, ...lookback } },
      orderBy: { date: 'desc' },
      select: { id: true, date: true },
      take: MAX_SAME_VENUE_SAMPLE,
    });

    const sameWeekday = pastEventsAtVenue
      .filter((e) => e.date.getUTCDay() === weekday)
      .slice(0, MAX_SAME_WEEKDAY_SAMPLE);

    if (sameWeekday.length >= MIN_SAMPLE_FOR_CONFIDENCE) {
      const stats = await this.loadHistoricalStats(sameWeekday.map((e) => e.id));
      const agg = this.aggregateHistoricalStats([...stats.values()]);
      if (agg.usableSampleSize >= MIN_SAMPLE_FOR_CONFIDENCE) {
        return { ...agg, basis: 'venue_weekday' };
      }
    }

    if (pastEventsAtVenue.length >= MIN_SAMPLE_FOR_CONFIDENCE) {
      const stats = await this.loadHistoricalStats(pastEventsAtVenue.map((e) => e.id));
      const agg = this.aggregateHistoricalStats([...stats.values()]);
      if (agg.usableSampleSize >= MIN_SAMPLE_FOR_CONFIDENCE) {
        return { ...agg, basis: 'venue_any_day' };
      }
    }

    const globalEvents = await this.prisma.events.findMany({
      where: { date: { lt: eventDate, ...lookback } },
      orderBy: { date: 'desc' },
      select: { id: true },
      take: MAX_GLOBAL_SAMPLE,
    });

    if (globalEvents.length >= MIN_SAMPLE_FOR_CONFIDENCE) {
      const stats = await this.loadHistoricalStats(globalEvents.map((e) => e.id));
      const agg = this.aggregateHistoricalStats([...stats.values()]);
      if (agg.usableSampleSize >= MIN_SAMPLE_FOR_CONFIDENCE) {
        return { ...agg, basis: 'global' };
      }
    }

    return {
      rate: DEFAULT_SHOW_UP_RATE,
      rateStddev: null,
      avgWalkins: 0,
      walkinsStddev: null,
      usableSampleSize: 0,
      basis: 'default',
    };
  }

  private async getCachedForecast(eventId: string): Promise<AttendanceForecast | null> {
    const cached = await this.prisma.event_forecasts.findFirst({
      where: {
        event_id: eventId,
        forecast_type: ForecastType.attendance,
        model_version: MODEL_VERSION,
      },
      orderBy: { generated_at: 'desc' },
    });
    if (!cached) return null;
    if (Date.now() - cached.generated_at.getTime() > CACHE_TTL_MS) return null;

    const snapshot = (cached.features_snapshot ?? {}) as Record<string, unknown>;
    const peopleInList = Number(snapshot.people_in_list ?? 0);
    const predictedFromList = Number(snapshot.predicted_from_list ?? 0);
    const expectedWalkins = Number(snapshot.expected_walkins ?? 0);
    return {
      event_id: eventId,
      people_in_list: peopleInList,
      predicted_from_list: predictedFromList,
      expected_walkins: expectedWalkins,
      predicted_value: Number(cached.predicted_value),
      lower_bound: cached.lower_bound !== null ? Number(cached.lower_bound) : 0,
      upper_bound: cached.upper_bound !== null ? Number(cached.upper_bound) : 0,
      confidence_score:
        cached.confidence_score !== null ? Number(cached.confidence_score) : 0,
      show_up_rate: peopleInList > 0 ? predictedFromList / peopleInList : 0,
      personalized_share: Number(snapshot.personalized_share ?? 0),
      sample_size: Number(snapshot.sample_size ?? 0),
      sample_basis: (snapshot.sample_basis as AttendanceForecast['sample_basis']) ?? 'default',
      generated_at: cached.generated_at.toISOString(),
    };
  }

  async getAttendanceForecast(eventId: string): Promise<AttendanceForecast> {
    const cached = await this.getCachedForecast(eventId);
    if (cached) return cached;

    const event = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { id: true, venue_id: true, date: true },
    });
    if (!event) throw new NotFoundException('Event not found');

    const [listReservations, { rate, rateStddev, avgWalkins, walkinsStddev, usableSampleSize, basis }] =
      await Promise.all([
        this.getListReservations(eventId),
        this.computeHistoricalForecastInputs(event.venue_id, event.date),
      ]);

    const peopleInList = listReservations.reduce((sum, r) => sum + r.guests, 0);

    const registeredUserIds = [
      ...new Set(
        listReservations
          .map((r) => r.user_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const personalRates = await this.getPersonalRates(registeredUserIds, eventId, event.date);

    // Blend: a person with enough personal history contributes at their own rate, everyone
    // else (new users and every guest reservation) contributes at the venue/global rate.
    let predictedFromList = 0;
    let personalizedGuests = 0;
    for (const r of listReservations) {
      const personalRate = r.user_id ? personalRates.get(r.user_id) : undefined;
      predictedFromList += (personalRate ?? rate) * r.guests;
      if (personalRate !== undefined) personalizedGuests += r.guests;
    }
    const personalizedShare = peopleInList > 0 ? personalizedGuests / peopleInList : 0;

    const predicted = predictedFromList + avgWalkins;

    // Per-person variance isn't modeled individually - the spread still comes from the
    // venue/global cascade's own historical variance, just applied around the (now
    // personalized) central estimate above.
    const listSpread = rateStddev !== null ? rateStddev * peopleInList : predictedFromList * 0.15;
    const walkinsSpread = walkinsStddev ?? avgWalkins * 0.3;
    const spread = Math.sqrt(listSpread ** 2 + walkinsSpread ** 2);

    const lowerBound = Math.max(0, Math.round(predicted - spread));
    const upperBound = Math.max(lowerBound, Math.round(predicted + spread));
    const confidence = this.confidenceFor(usableSampleSize, basis);

    await this.prisma.event_forecasts.create({
      data: {
        event_id: eventId,
        venue_id: event.venue_id,
        forecast_type: ForecastType.attendance,
        model_version: MODEL_VERSION,
        predicted_value: new Prisma.Decimal(Math.round(predicted)),
        lower_bound: new Prisma.Decimal(lowerBound),
        upper_bound: new Prisma.Decimal(upperBound),
        confidence_score: new Prisma.Decimal(confidence.toFixed(2)),
        features_snapshot: {
          people_in_list: peopleInList,
          predicted_from_list: Math.round(predictedFromList),
          expected_walkins: Math.round(avgWalkins),
          personalized_share: personalizedShare,
          sample_size: usableSampleSize,
          sample_basis: basis,
        },
      },
    });

    return {
      event_id: eventId,
      people_in_list: peopleInList,
      predicted_from_list: Math.round(predictedFromList),
      expected_walkins: Math.round(avgWalkins),
      predicted_value: Math.round(predicted),
      lower_bound: lowerBound,
      upper_bound: upperBound,
      confidence_score: confidence,
      show_up_rate: peopleInList > 0 ? predictedFromList / peopleInList : rate,
      personalized_share: personalizedShare,
      sample_size: usableSampleSize,
      sample_basis: basis,
      generated_at: new Date().toISOString(),
    };
  }
}
