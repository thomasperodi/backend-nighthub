import { Injectable, NotFoundException } from '@nestjs/common';
import { ForecastType, Prisma, ReservationStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MODEL_VERSION = 'moving-average-v1';
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h
const MIN_SAMPLE_FOR_CONFIDENCE = 3;
const MAX_SAME_WEEKDAY_SAMPLE = 12;
const MAX_SAME_VENUE_SAMPLE = 20;
const MAX_GLOBAL_SAMPLE = 50;
// Used only when there is truly zero historical data anywhere (brand new venue) - a
// deliberately conservative placeholder, not a claim of real predictive power (reflected in
// the very low confidence_score attached to it).
const DEFAULT_SHOW_UP_RATE = 0.7;

type HistoricalSample = { guests: number; entries: number };

export type AttendanceForecast = {
  event_id: string;
  people_in_list: number;
  predicted_value: number;
  lower_bound: number;
  upper_bound: number;
  confidence_score: number;
  show_up_rate: number;
  sample_size: number;
  sample_basis: 'venue_weekday' | 'venue_any_day' | 'global' | 'default';
  generated_at: string;
};

/**
 * Simple statistical attendance forecast (no ML): predicted show-up count for an event =
 * historical show-up rate (real check-ins / booked list guests, from comparable past events)
 * applied to the current number of people in the list. Falls back to a wider, less specific
 * comparison pool when there isn't enough history yet, which is reflected in a lower
 * confidence_score rather than hidden.
 */
@Injectable()
export class AttendanceForecastService {
  constructor(private readonly prisma: PrismaService) {}

  private async getListGuestsCount(
    eventId: string,
    statuses: ReservationStatus[],
  ): Promise<number> {
    const result = await this.prisma.reservations.aggregate({
      where: { event_id: eventId, type: 'entry', status: { in: statuses } },
      _sum: { guests: true },
    });
    return result?._sum?.guests ?? 0;
  }

  private async getCheckedInCount(eventId: string): Promise<number> {
    return this.prisma.entries.count({
      where: { event_id: eventId, method: 'QR' },
    });
  }

  private async sampleFromEvents(
    events: Array<{ id: string }>,
  ): Promise<HistoricalSample[]> {
    return Promise.all(
      events.map(async (event) => ({
        guests: await this.getListGuestsCount(event.id, [
          'confirmed',
          'completed',
        ]),
        entries: await this.getCheckedInCount(event.id),
      })),
    );
  }

  private aggregateShowUpRate(samples: HistoricalSample[]): {
    rate: number;
    stddev: number | null;
    usableSampleSize: number;
  } {
    const usable = samples.filter((s) => s.guests > 0);
    if (!usable.length) return { rate: DEFAULT_SHOW_UP_RATE, stddev: null, usableSampleSize: 0 };

    const totalGuests = usable.reduce((sum, s) => sum + s.guests, 0);
    const totalEntries = usable.reduce((sum, s) => sum + s.entries, 0);
    const rate = totalGuests > 0 ? totalEntries / totalGuests : DEFAULT_SHOW_UP_RATE;

    if (usable.length < 2) return { rate, stddev: null, usableSampleSize: usable.length };

    const ratios = usable.map((s) => s.entries / s.guests);
    const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
    const variance =
      ratios.reduce((sum, r) => sum + (r - mean) ** 2, 0) / ratios.length;

    return { rate, stddev: Math.sqrt(variance), usableSampleSize: usable.length };
  }

  private confidenceFor(sampleSize: number, basis: AttendanceForecast['sample_basis']): number {
    if (basis === 'default') return 0.1;
    const base = basis === 'venue_weekday' ? 0.55 : basis === 'venue_any_day' ? 0.4 : 0.3;
    const bonus = Math.min(0.35, sampleSize * 0.05);
    return Math.min(0.9, base + bonus);
  }

  private async computeShowUpRate(
    venueId: string,
    eventDate: Date,
  ): Promise<{
    rate: number;
    stddev: number | null;
    sampleSize: number;
    basis: AttendanceForecast['sample_basis'];
  }> {
    const weekday = eventDate.getUTCDay();

    const pastEventsAtVenue = await this.prisma.events.findMany({
      where: { venue_id: venueId, date: { lt: eventDate } },
      orderBy: { date: 'desc' },
      select: { id: true, date: true },
      take: MAX_SAME_VENUE_SAMPLE,
    });

    const sameWeekday = pastEventsAtVenue
      .filter((e) => e.date.getUTCDay() === weekday)
      .slice(0, MAX_SAME_WEEKDAY_SAMPLE);

    if (sameWeekday.length >= MIN_SAMPLE_FOR_CONFIDENCE) {
      const samples = await this.sampleFromEvents(sameWeekday);
      const { rate, stddev, usableSampleSize } = this.aggregateShowUpRate(samples);
      if (usableSampleSize >= MIN_SAMPLE_FOR_CONFIDENCE) {
        return { rate, stddev, sampleSize: usableSampleSize, basis: 'venue_weekday' };
      }
    }

    if (pastEventsAtVenue.length >= MIN_SAMPLE_FOR_CONFIDENCE) {
      const samples = await this.sampleFromEvents(pastEventsAtVenue);
      const { rate, stddev, usableSampleSize } = this.aggregateShowUpRate(samples);
      if (usableSampleSize >= MIN_SAMPLE_FOR_CONFIDENCE) {
        return { rate, stddev, sampleSize: usableSampleSize, basis: 'venue_any_day' };
      }
    }

    const globalEvents = await this.prisma.events.findMany({
      where: { date: { lt: eventDate } },
      orderBy: { date: 'desc' },
      select: { id: true },
      take: MAX_GLOBAL_SAMPLE,
    });

    if (globalEvents.length >= MIN_SAMPLE_FOR_CONFIDENCE) {
      const samples = await this.sampleFromEvents(globalEvents);
      const { rate, stddev, usableSampleSize } = this.aggregateShowUpRate(samples);
      if (usableSampleSize >= MIN_SAMPLE_FOR_CONFIDENCE) {
        return { rate, stddev, sampleSize: usableSampleSize, basis: 'global' };
      }
    }

    return { rate: DEFAULT_SHOW_UP_RATE, stddev: null, sampleSize: 0, basis: 'default' };
  }

  private async getCachedForecast(
    eventId: string,
  ): Promise<AttendanceForecast | null> {
    const cached = await this.prisma.event_forecasts.findFirst({
      where: { event_id: eventId, forecast_type: ForecastType.attendance },
      orderBy: { generated_at: 'desc' },
    });
    if (!cached) return null;
    if (Date.now() - cached.generated_at.getTime() > CACHE_TTL_MS) return null;

    const snapshot = (cached.features_snapshot ?? {}) as Record<string, unknown>;
    return {
      event_id: eventId,
      people_in_list: Number(snapshot.people_in_list ?? 0),
      predicted_value: Number(cached.predicted_value),
      lower_bound: cached.lower_bound !== null ? Number(cached.lower_bound) : 0,
      upper_bound: cached.upper_bound !== null ? Number(cached.upper_bound) : 0,
      confidence_score:
        cached.confidence_score !== null ? Number(cached.confidence_score) : 0,
      show_up_rate: Number(snapshot.show_up_rate ?? 0),
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

    const [peopleInList, { rate, stddev, sampleSize, basis }] = await Promise.all([
      this.getListGuestsCount(eventId, ['pending', 'confirmed']),
      this.computeShowUpRate(event.venue_id, event.date),
    ]);

    const predicted = rate * peopleInList;
    const spread =
      stddev !== null ? stddev * peopleInList : predicted * 0.15;
    const lowerBound = Math.max(0, Math.round(predicted - spread));
    const upperBound = Math.max(lowerBound, Math.round(predicted + spread));
    const confidence = this.confidenceFor(sampleSize, basis);

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
          show_up_rate: rate,
          sample_size: sampleSize,
          sample_basis: basis,
        },
      },
    });

    return {
      event_id: eventId,
      people_in_list: peopleInList,
      predicted_value: Math.round(predicted),
      lower_bound: lowerBound,
      upper_bound: upperBound,
      confidence_score: confidence,
      show_up_rate: rate,
      sample_size: sampleSize,
      sample_basis: basis,
      generated_at: new Date().toISOString(),
    };
  }
}
