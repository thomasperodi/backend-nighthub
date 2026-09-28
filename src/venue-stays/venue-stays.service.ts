import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PushDispatchService } from '../common/push/push-dispatch.service';
import { eventEndMs } from '../common/event-time.util';
import { BadgesService } from '../badges/badges.service';

type EventTimes = {
  date: Date | null;
  start_time: Date | null;
  end_time: Date | null;
};

/** How an exit was detected, stored in venue_stays.exit_source (see schema). */
export type StayExitSource = 'geofence' | 'app' | 'auto';

/**
 * Stays with a real exit time: only geofence exits. 'app' is only an upper bound (the user may
 * have left hours before opening the app) and 'auto' is the end of the night, so both would
 * inflate the average stay and fake exit-time badges. Use it for every "permanenza" metric.
 */
export const MEASURED_STAY_WHERE = {
  duration_ms: { not: null },
  exit_source: 'geofence',
} as const;

/** A stay without an event is closed after this long if the app never reports the exit. */
const MAX_STAY_WITHOUT_EVENT_MS = 12 * 60 * 60 * 1000;

/**
 * Time spent at a venue ("permanenza"), for venue analytics, the recommendation algorithm
 * and badges. How a stay is tracked:
 * - enter: server-side, when the user is checked in at the door (startStayOnCheckIn). The
 *   check-in is the ground truth, no location needed.
 * - exit: from the app - background geofence if the user allowed "always" location
 *   (`geofence`), otherwise a location check when the app is opened (`app`).
 * - if the app never reports it: closed at the end of the night (`auto`, estimated), see
 *   closeExpiredStays (daily cron) and when the user checks in somewhere else.
 */
@Injectable()
export class VenueStaysService {
  private readonly logger = new Logger(VenueStaysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pushDispatch: PushDispatchService,
    private readonly badges: BadgesService,
  ) {}

  /**
   * Opens the stay when the user is checked in at the door (QR or quick entry by staff) and
   * tells the app where the venue is, so it can watch for the exit. Never throws: a stay is
   * analytics, it must not break the check-in.
   */
  async startStayOnCheckIn(userId: string | null | undefined, eventId: string) {
    if (!userId) return;
    try {
      const event = await this.prisma.events.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          venue: {
            select: {
              id: true,
              name: true,
              latitude: true,
              longitude: true,
              radius_geofence: true,
            },
          },
        },
      });
      if (!event?.venue) return;
      const venue = event.venue;
      const now = new Date();

      // One place at a time: a stay still open somewhere else ends now.
      await this.closeOpenStays(
        { user_id: userId, NOT: { venue_id: venue.id, event_id: event.id } },
        () => now,
      );

      const open = await this.prisma.venue_stays.findFirst({
        where: {
          user_id: userId,
          venue_id: venue.id,
          event_id: event.id,
          exited_at: null,
        },
        select: { id: true },
      });
      if (!open) {
        await this.prisma.venue_stays.create({
          data: {
            user_id: userId,
            venue_id: venue.id,
            event_id: event.id,
            entered_at: now,
          },
        });
      }

      const latitude = venue.latitude === null ? null : Number(venue.latitude);
      const longitude =
        venue.longitude === null ? null : Number(venue.longitude);
      await this.pushDispatch.notifyUser(userId, {
        title: 'Ingresso registrato',
        body: `Buona serata al ${venue.name ?? 'locale'}!`,
        // The app watches this area to record when the user leaves (only with coordinates).
        data: {
          type: 'venue_stay',
          venue_id: venue.id,
          event_id: event.id,
          ...(Number.isFinite(latitude) && Number.isFinite(longitude)
            ? { latitude, longitude, radius: venue.radius_geofence ?? 100 }
            : {}),
        },
      });
    } catch (error) {
      this.logger.warn({
        msg: 'venue stay not started',
        userId,
        eventId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async checkpoint(params: {
    user_id: string;
    venue_id: string;
    event_id?: string;
    event_type: 'enter' | 'exit';
    timestamp?: string;
    exit_source?: 'geofence' | 'app';
  }) {
    const { user_id, venue_id, event_id, event_type, timestamp } = params;

    if (!user_id) throw new BadRequestException('user_id required');
    if (!venue_id) throw new BadRequestException('venue_id required');

    if (event_id) {
      const event = await this.prisma.events.findUnique({
        where: { id: event_id },
        select: { id: true, venue_id: true },
      });
      if (!event) throw new NotFoundException('Event not found');
      if (event.venue_id !== venue_id) {
        throw new BadRequestException('event_id does not belong to venue_id');
      }
    }

    const at = timestamp ? new Date(timestamp) : new Date();
    if (Number.isNaN(at.getTime())) {
      throw new BadRequestException('timestamp must be ISO8601');
    }
    // A client clock can be off: never in the future.
    const when = new Date(Math.min(at.getTime(), Date.now()));

    if (event_type === 'enter') {
      const openStay = await this.prisma.venue_stays.findFirst({
        where: {
          user_id,
          venue_id,
          event_id: event_id ?? null,
          exited_at: null,
        },
        orderBy: { entered_at: 'desc' },
      });

      if (openStay) return openStay;

      return this.prisma.venue_stays.create({
        data: {
          user_id,
          venue_id,
          event_id: event_id ?? null,
          entered_at: when,
        },
      });
    }

    const openStay = await this.prisma.venue_stays.findFirst({
      where: { user_id, venue_id, event_id: event_id ?? null, exited_at: null },
      orderBy: { entered_at: 'desc' },
    });

    if (!openStay) {
      throw new NotFoundException('No open stay for this venue');
    }

    // Not before the entry (a delayed/old client timestamp).
    let exitedAt = new Date(
      Math.max(when.getTime(), openStay.entered_at.getTime()),
    );
    let source: StayExitSource = params.exit_source ?? 'app';

    // Reported after the night was over (e.g. the geofence fired late, or the app was opened
    // the next morning): the real exit is unknown, so it counts as the end of the night,
    // estimated - never as a measured "stayed until 9am".
    const event = openStay.event_id
      ? (await this.eventTimes([openStay.event_id])).get(openStay.event_id)
      : undefined;
    const endMs = event ? eventEndMs(event) : null;
    if (endMs !== null && exitedAt.getTime() > endMs) {
      exitedAt = new Date(Math.max(endMs, openStay.entered_at.getTime()));
      source = 'auto';
    }

    const updated = await this.prisma.venue_stays.update({
      where: { id: openStay.id },
      data: {
        exited_at: exitedAt,
        duration_ms: exitedAt.getTime() - openStay.entered_at.getTime(),
        exit_source: source,
      },
    });

    // A measured exit can unlock exit-time badges (e.g. staying until the end of the night).
    if (source === 'geofence') {
      void this.badges.evaluateForUser(user_id).catch(() => undefined);
    }
    return updated;
  }

  /**
   * Closes the stays the app never reported an exit for, once their night is over: exit =
   * end of the event (or MAX_STAY_WITHOUT_EVENT_MS after entry without an event), marked
   * `auto` so analytics can tell an estimate from a measured exit. Run by the daily cron.
   */
  async closeExpiredStays(nowMs = Date.now()) {
    const closed = await this.closeOpenStays({}, (stay) => {
      const end = stay.event
        ? eventEndMs(stay.event)
        : stay.entered_at.getTime() + MAX_STAY_WITHOUT_EVENT_MS;
      return end !== null && end <= nowMs ? new Date(end) : null;
    });
    return { success: true, closed };
  }

  /** Closes the open stays matching `where` at the time returned by `exitAt` (null = keep open). */
  private async closeOpenStays(
    where: Record<string, unknown>,
    exitAt: (stay: {
      entered_at: Date;
      event: EventTimes | null;
    }) => Date | null,
  ) {
    const open = await this.prisma.venue_stays.findMany({
      where: { ...where, exited_at: null },
      select: { id: true, entered_at: true, event_id: true },
      take: 500,
    });
    // venue_stays has event_id but no relation to events: one query for all of them.
    const events = await this.eventTimes(open.map((s) => s.event_id));

    let closed = 0;
    for (const stay of open) {
      const at = exitAt({
        entered_at: stay.entered_at,
        event: stay.event_id ? (events.get(stay.event_id) ?? null) : null,
      });
      if (!at) continue;
      const exitedAt = new Date(
        Math.max(at.getTime(), stay.entered_at.getTime()),
      );
      await this.prisma.venue_stays.update({
        where: { id: stay.id },
        data: {
          exited_at: exitedAt,
          duration_ms: exitedAt.getTime() - stay.entered_at.getTime(),
          exit_source: 'auto',
        },
      });
      closed += 1;
    }
    return closed;
  }

  private async eventTimes(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (!unique.length) return new Map<string, EventTimes>();
    const rows = await this.prisma.events.findMany({
      where: { id: { in: unique } },
      select: { id: true, date: true, start_time: true, end_time: true },
    });
    return new Map<string, EventTimes>(rows.map((e) => [e.id, e]));
  }

  async list(params: {
    user_id?: string;
    venue_id?: string;
    event_id?: string;
    limit?: number;
  }) {
    const take = Math.min(Math.max(params.limit ?? 100, 1), 500);

    return this.prisma.venue_stays.findMany({
      where: {
        event_id: params.event_id,
        user_id: params.user_id,
        venue_id: params.venue_id,
      },
      orderBy: { entered_at: 'desc' },
      take,
    });
  }

  /**
   * The user's stay still open right now, with where the venue is: the app uses it on
   * launch to resume watching for the exit (e.g. after being closed during the night).
   */
  async currentStay(userId: string) {
    const stay = await this.prisma.venue_stays.findFirst({
      where: { user_id: userId, exited_at: null },
      orderBy: { entered_at: 'desc' },
      select: {
        id: true,
        venue_id: true,
        event_id: true,
        entered_at: true,
        venue: {
          select: {
            name: true,
            latitude: true,
            longitude: true,
            radius_geofence: true,
          },
        },
      },
    });
    if (!stay) return null;

    // Its night is already over: close it now instead of asking the app to watch it.
    const event = stay.event_id
      ? (await this.eventTimes([stay.event_id])).get(stay.event_id)
      : undefined;
    const end = event ? eventEndMs(event) : null;
    if (end !== null && end <= Date.now()) {
      await this.closeExpiredStays();
      return null;
    }

    const lat =
      stay.venue.latitude === null ? null : Number(stay.venue.latitude);
    const lng =
      stay.venue.longitude === null ? null : Number(stay.venue.longitude);
    return {
      id: stay.id,
      venue_id: stay.venue_id,
      event_id: stay.event_id,
      entered_at: stay.entered_at,
      venue_name: stay.venue.name,
      latitude: Number.isFinite(lat) ? lat : null,
      longitude: Number.isFinite(lng) ? lng : null,
      radius: stay.venue.radius_geofence ?? 100,
    };
  }
}
