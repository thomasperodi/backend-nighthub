import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TtlCache } from '../common/ttl-cache';
import { BadgeCriteria } from './badge-criteria.types';

type EntriesCacheRow = {
  event: { venue_id: string; start_time: Date | null; date: Date };
};
type EntriesCache = () => Promise<EntriesCacheRow[]>;

type BadgeRow = {
  id: string;
  code: string;
  category: string;
  rarity: string;
  icon: string;
  name: string;
  description: string;
  criteria: unknown;
  is_secret: boolean;
  is_public: boolean;
  sort_order: number;
  available_from: Date | null;
  available_until: Date | null;
};

@Injectable()
export class BadgesService {
  private readonly logger = new Logger(BadgesService.name);
  // Self-view progress (getBadgesForViewer) computes every locked badge's criteria live -
  // for criteria like coattend_group/coattend_same_friend that's several sequential queries
  // *per badge*, ~2s end to end on a full catalog. Badge progress changes rarely (a handful
  // of events a day at most), so a few minutes of staleness is a good trade for not
  // re-running that on every profile view. POST /badges/sync is unaffected - it always
  // evaluates fresh - only the next GET can read a cached result for up to the TTL below.
  private readonly selfBadgesCache = new TtlCache();
  private static readonly SELF_BADGES_CACHE_TTL_MS = 5 * 60_000;

  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------
  // Public read API
  // ---------------------------------------------------------------------

  /**
   * Pure catalog: every active badge with its name/description/icon/rarity,
   * no unlock status. Secret badges are always masked here since there's no
   * viewer to check unlock state against. Used for a "browse all badges"
   * screen, not for a profile.
   */
  async getStaticCatalog() {
    const badges = await this.prisma.badges.findMany({
      where: { is_active: true },
      orderBy: [{ category: 'asc' }, { sort_order: 'asc' }],
    });

    return badges.map((badge) =>
      this.toPublicBadge(badge, { isUnlocked: false }),
    );
  }

  /**
   * Badge collection of `targetUserId` as seen by `viewerId`.
   * - Viewing yourself: every active badge, with live progress for locked
   *   ones and unlocked_at for earned ones.
   * - Viewing a friend: only badges flagged `is_public`, no progress numbers
   *   (locked ones just show as locked) - you must be friends to view at all.
   */
  async getBadgesForViewer(viewerId: string, targetUserId: string) {
    const isSelf = viewerId === targetUserId;

    if (!isSelf) {
      const isFriend = await this.prisma.friendships.findUnique({
        where: {
          user_id_friend_id: { user_id: viewerId, friend_id: targetUserId },
        },
      });
      if (!isFriend) {
        throw new ForbiddenException('Puoi vedere solo i badge dei tuoi amici');
      }

      return this.computeBadgesForFriend(targetUserId);
    }

    // Only the self view computes live progress for locked badges - the expensive part -
    // so only it goes through the cache. Friend views (above) skip progress entirely and
    // stay cheap without needing it.
    return this.selfBadgesCache.getOrCompute(
      targetUserId,
      BadgesService.SELF_BADGES_CACHE_TTL_MS,
      () => this.computeBadgesForSelf(targetUserId),
    );
  }

  private async computeBadgesForFriend(targetUserId: string) {
    const [badges, unlocked] = await Promise.all([
      this.prisma.badges.findMany({
        where: { is_active: true, is_public: true },
        orderBy: [{ category: 'asc' }, { sort_order: 'asc' }],
      }),
      this.prisma.user_badges.findMany({ where: { user_id: targetUserId } }),
    ]);

    const unlockedByBadgeId = new Map(unlocked.map((u) => [u.badge_id, u]));

    return badges.map((badge) => {
      const unlockedEntry = unlockedByBadgeId.get(badge.id);
      return this.toPublicBadge(badge, {
        isUnlocked: !!unlockedEntry,
        unlockedAt: unlockedEntry?.unlocked_at ?? null,
        progress: null,
      });
    });
  }

  private async computeBadgesForSelf(userId: string) {
    const [badges, unlocked] = await Promise.all([
      this.prisma.badges.findMany({
        where: { is_active: true },
        orderBy: [{ category: 'asc' }, { sort_order: 'asc' }],
      }),
      this.prisma.user_badges.findMany({ where: { user_id: userId } }),
    ]);

    const unlockedByBadgeId = new Map(unlocked.map((u) => [u.badge_id, u]));
    // Several criteria types (distinct_venues_count, weekend_streak, event_before/after_time,
    // seasonal_window) each independently re-fetch the user's whole `entries` history. Shared
    // once per call here instead of once per badge.
    const entriesCache = this.createEntriesCache(userId);

    return Promise.all(
      badges.map(async (badge) => {
        const unlockedEntry = unlockedByBadgeId.get(badge.id);
        const isUnlocked = !!unlockedEntry;
        const criteria = badge.criteria as unknown as BadgeCriteria;

        const progress =
          !isUnlocked && criteria.type !== 'manual'
            ? await this.computeProgress(userId, criteria, entriesCache).catch(
                () => null,
              )
            : null;

        return this.toPublicBadge(badge, {
          isUnlocked,
          unlockedAt: unlockedEntry?.unlocked_at ?? null,
          progress,
        });
      }),
    );
  }

  private toPublicBadge(
    badge: {
      id: string;
      code: string;
      category: string;
      rarity: string;
      icon: string;
      name: string;
      description: string;
      is_secret: boolean;
    },
    state: {
      isUnlocked: boolean;
      unlockedAt?: Date | null;
      progress?: { current: number; target: number } | null;
    },
  ) {
    if (badge.is_secret && !state.isUnlocked) {
      return {
        id: badge.id,
        code: badge.code,
        category: badge.category,
        rarity: badge.rarity,
        icon: badge.icon,
        name: badge.name,
        description: badge.description,
        isSecret: true,
        isUnlocked: false,
        unlockedAt: null,
        progress: null,
      };
    }

    return {
      id: badge.id,
      code: badge.code,
      category: badge.category,
      rarity: badge.rarity,
      icon: badge.icon,
      name: badge.name,
      description: badge.description,
      isSecret: badge.is_secret,
      isUnlocked: state.isUnlocked,
      unlockedAt: state.unlockedAt ?? null,
      progress: state.progress ?? null,
    };
  }

  getUnlockedForUser(userId: string) {
    return this.prisma.user_badges.findMany({
      where: { user_id: userId },
      include: { badge: true },
      orderBy: { unlocked_at: 'desc' },
    });
  }

  private static readonly NIGHT_LEVELS: {
    level: number;
    code: string;
    name: string;
    icon: string;
    minEvents: number;
  }[] = [
    { level: 1, code: 'newbie', name: 'Newbie', icon: '🌱', minEvents: 0 },
    {
      level: 2,
      code: 'night_starter',
      name: 'Night Starter',
      icon: '🌙',
      minEvents: 3,
    },
    {
      level: 3,
      code: 'night_lover',
      name: 'Night Lover',
      icon: '🔥',
      minEvents: 10,
    },
    {
      level: 4,
      code: 'night_addict',
      name: 'Night Addict',
      icon: '🖤',
      minEvents: 25,
    },
    {
      level: 5,
      code: 'night_player',
      name: 'Night Player',
      icon: '👑',
      minEvents: 50,
    },
    {
      level: 6,
      code: 'night_legend',
      name: 'Night Legend',
      icon: '💎',
      minEvents: 100,
    },
    {
      level: 7,
      code: 'night_god',
      name: 'Night God',
      icon: '🐐',
      minEvents: 200,
    },
  ] as const;

  /** Separate from the badge collection: reflects overall activity via events attended. */
  async getNightLevel(userId: string) {
    const eventsCount = await this.prisma.entries.count({
      where: { user_id: userId },
    });
    const levels = BadgesService.NIGHT_LEVELS;

    let current = levels[0];
    for (const level of levels) {
      if (eventsCount >= level.minEvents) current = level;
    }
    const next = levels.find((l) => l.minEvents > current.minEvents) ?? null;

    return {
      eventsCount,
      current,
      next,
      eventsToNextLevel: next ? next.minEvents - eventsCount : 0,
    };
  }

  async markSeen(userId: string, userBadgeId: string) {
    return this.prisma.user_badges.updateMany({
      where: { id: userBadgeId, user_id: userId, seen_at: null },
      data: { seen_at: new Date() },
    });
  }

  // ---------------------------------------------------------------------
  // Evaluation engine
  // ---------------------------------------------------------------------

  /**
   * Re-evaluates every active, non-manual badge for a user and unlocks any
   * whose criteria are now met. Safe to call often (e.g. after check-in,
   * reservation, friendship) - already-unlocked badges are skipped.
   */
  async evaluateForUser(userId: string) {
    const now = new Date();
    const candidateBadges = await this.prisma.badges.findMany({
      where: {
        is_active: true,
        AND: [
          { OR: [{ available_from: null }, { available_from: { lte: now } }] },
          {
            OR: [{ available_until: null }, { available_until: { gte: now } }],
          },
        ],
      },
    });

    if (candidateBadges.length === 0) return [];

    const alreadyUnlocked = await this.prisma.user_badges.findMany({
      where: {
        user_id: userId,
        badge_id: { in: candidateBadges.map((b) => b.id) },
      },
      select: { badge_id: true },
    });
    const unlockedIds = new Set(alreadyUnlocked.map((u) => u.badge_id));

    const newlyUnlocked: BadgeRow[] = [];
    const entriesCache = this.createEntriesCache(userId);

    for (const badge of candidateBadges) {
      if (unlockedIds.has(badge.id)) continue;

      const criteria = badge.criteria as unknown as BadgeCriteria;
      if (criteria.type === 'manual') continue;

      let meets = false;
      let value: number | null = null;
      try {
        const result = await this.computeProgress(
          userId,
          criteria,
          entriesCache,
        );
        meets = result.current >= result.target;
        value = result.current;
      } catch (error) {
        this.logger.warn(
          `Badge evaluation failed for badge=${badge.code} user=${userId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
        continue;
      }

      if (!meets) continue;

      try {
        await this.prisma.user_badges.create({
          data: {
            user_id: userId,
            badge_id: badge.id,
            progress_value: value ?? undefined,
          },
        });
        newlyUnlocked.push(badge as unknown as BadgeRow);
      } catch {
        // Unique constraint race (evaluated concurrently) - ignore.
      }
    }

    return newlyUnlocked;
  }

  /** Explicit award for secret/manual badges (e.g. easter eggs, admin grants). */
  async awardManualBadge(userId: string, badgeCode: string) {
    const badge = await this.prisma.badges.findUnique({
      where: { code: badgeCode },
    });
    if (!badge) return null;

    return this.prisma.user_badges.upsert({
      where: { user_id_badge_id: { user_id: userId, badge_id: badge.id } },
      update: {},
      create: { user_id: userId, badge_id: badge.id },
    });
  }

  // ---------------------------------------------------------------------
  // Metric computation - one branch per criteria type
  // ---------------------------------------------------------------------

  /** A per-evaluation-pass, memoized `entries` fetch shared across criteria types that all
   * need the same "this user's attended events" data (venue/time/date), so a badge sweep
   * over many badges hits `entries` once instead of once per matching criteria type. */
  private createEntriesCache(userId: string): EntriesCache {
    let promise: Promise<EntriesCacheRow[]> | null = null;
    return () => {
      if (!promise) {
        promise = this.prisma.entries.findMany({
          where: { user_id: userId },
          select: {
            event: { select: { venue_id: true, start_time: true, date: true } },
          },
        });
      }
      return promise;
    };
  }

  private async computeProgress(
    userId: string,
    criteria: BadgeCriteria,
    entriesCache: EntriesCache,
  ): Promise<{ current: number; target: number }> {
    switch (criteria.type) {
      case 'entries_count': {
        const current = await this.prisma.entries.count({
          where: { user_id: userId },
        });
        return { current, target: criteria.threshold };
      }

      case 'distinct_venues_count': {
        const rows = await entriesCache();
        const distinct = new Set(rows.map((r) => r.event.venue_id));
        return { current: distinct.size, target: criteria.threshold };
      }

      case 'friends_count': {
        const current = await this.prisma.friendships.count({
          where: { user_id: userId },
        });
        return { current, target: criteria.threshold };
      }

      case 'table_reservations_count': {
        const current = await this.prisma.reservations.count({
          where: {
            user_id: userId,
            type: 'table',
            status: { in: ['confirmed', 'completed'] },
          },
        });
        return { current, target: criteria.threshold };
      }

      case 'spend_total': {
        const rows = await this.prisma.reservations.aggregate({
          where: {
            user_id: userId,
            type: 'table',
            status: { in: ['confirmed', 'completed'] },
          },
          _sum: { total_amount: true },
        });
        const current = Number(rows._sum.total_amount ?? 0);
        return { current, target: criteria.threshold };
      }

      case 'weekend_streak': {
        const rows = await entriesCache();
        const current = this.computeWeekendStreak(rows);
        return { current, target: criteria.weeks };
      }

      case 'event_before_time': {
        const rows = await entriesCache();
        const current = this.countEntriesByEventTime(rows, {
          before: criteria.before,
        });
        return { current, target: criteria.threshold };
      }

      case 'event_after_time': {
        const rows = await entriesCache();
        const current = this.countEntriesByEventTime(rows, {
          after: criteria.after,
        });
        return { current, target: criteria.threshold };
      }

      case 'seasonal_window': {
        const rows = await entriesCache();
        const current = this.countEntriesInSeasonalWindow(rows, criteria);
        return { current, target: criteria.threshold };
      }

      case 'account_age_days': {
        const user = await this.prisma.users.findUnique({
          where: { id: userId },
          select: { created_at: true },
        });
        if (!user) return { current: 0, target: criteria.days };
        const ageDays = Math.floor(
          (Date.now() - user.created_at.getTime()) / (1000 * 60 * 60 * 24),
        );
        return { current: ageDays, target: criteria.days };
      }

      case 'profile_completed': {
        const user = await this.prisma.users.findUnique({
          where: { id: userId },
          select: {
            name: true,
            avatar: true,
            phone: true,
            birth_date: true,
            sesso: true,
          },
        });
        const filled = user
          ? [
              user.name,
              user.avatar,
              user.phone,
              user.birth_date,
              user.sesso,
            ].filter(Boolean).length
          : 0;
        return { current: filled, target: 5 };
      }

      case 'early_adopter': {
        const user = await this.prisma.users.findUnique({
          where: { id: userId },
          select: { created_at: true },
        });
        if (!user)
          return { current: Number.MAX_SAFE_INTEGER, target: criteria.rank };
        const rank = await this.prisma.users.count({
          where: { created_at: { lte: user.created_at } },
        });
        // Lower rank is better: invert so "current >= target" unlocks it.
        return { current: rank <= criteria.rank ? 1 : 0, target: 1 };
      }

      case 'coattend_same_friend': {
        const current = await this.computeMaxCoattendanceWithAnyFriend(userId);
        return { current, target: criteria.threshold };
      }

      case 'coattend_group': {
        const current = await this.computeGroupCoattendanceEvents(
          userId,
          criteria.minFriendsPresent,
        );
        return { current, target: criteria.eventsThreshold };
      }

      case 'manual':
        return { current: 0, target: 1 };

      default:
        return { current: 0, target: 1 };
    }
  }

  private countEntriesByEventTime(
    entries: EntriesCacheRow[],
    window: { before?: string } | { after?: string },
  ) {
    const toMinutes = (t: string) => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + (m || 0);
    };

    return entries.filter((e) => {
      if (!e.event.start_time) return false;
      const start = e.event.start_time;
      const minutes = start.getUTCHours() * 60 + start.getUTCMinutes();
      if ('before' in window && window.before)
        return minutes < toMinutes(window.before);
      if ('after' in window && window.after)
        return minutes >= toMinutes(window.after);
      return false;
    }).length;
  }

  private countEntriesInSeasonalWindow(
    entries: EntriesCacheRow[],
    window: {
      monthFrom: number;
      dayFrom: number;
      monthTo: number;
      dayTo: number;
    },
  ) {
    // Compare month/day pairs as MMDD integers so leap years don't matter.
    const from = window.monthFrom * 100 + window.dayFrom;
    const to = window.monthTo * 100 + window.dayTo;
    const wraps = from > to;

    return entries.filter((e) => {
      const d = e.event.date;
      const key = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
      return wraps ? key >= from || key <= to : key >= from && key <= to;
    }).length;
  }

  /** Longest run of consecutive ISO weeks (Mon-Sun) with at least one attended event.
   * Dedupes to one week-key per week and sorts before walking, so the input rows don't
   * need to arrive pre-ordered by date. */
  private computeWeekendStreak(entries: EntriesCacheRow[]): number {
    const weekKeys = new Set(entries.map((e) => this.isoWeekKey(e.event.date)));
    const sortedWeeks = Array.from(weekKeys).sort();

    let longest = 0;
    let current = 0;
    let previousWeekIndex: number | null = null;

    for (const weekKey of sortedWeeks) {
      const weekIndex = this.absoluteWeekIndex(weekKey);
      if (previousWeekIndex !== null && weekIndex === previousWeekIndex + 1) {
        current += 1;
      } else {
        current = 1;
      }
      longest = Math.max(longest, current);
      previousWeekIndex = weekIndex;
    }

    return longest;
  }

  private isoWeekKey(date: Date): string {
    const d = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    return `${d.getUTCFullYear()}-${weekNo}`;
  }

  private absoluteWeekIndex(weekKey: string): number {
    const [year, week] = weekKey.split('-').map(Number);
    return year * 53 + week;
  }

  /** Highest number of shared attended events between the user and any single friend. */
  private async computeMaxCoattendanceWithAnyFriend(
    userId: string,
  ): Promise<number> {
    const [myEventIds, friendIds] = await Promise.all([
      this.prisma.entries.findMany({
        where: { user_id: userId },
        select: { event_id: true },
      }),
      this.prisma.friendships.findMany({
        where: { user_id: userId },
        select: { friend_id: true },
      }),
    ]);

    if (friendIds.length === 0) return 0;

    const myEventSet = new Set(myEventIds.map((e) => e.event_id));
    if (myEventSet.size === 0) return 0;

    const friendEntries = await this.prisma.entries.findMany({
      where: {
        user_id: { in: friendIds.map((f) => f.friend_id) },
        event_id: { in: Array.from(myEventSet) },
      },
      select: { user_id: true, event_id: true },
    });

    const counts = new Map<string, number>();
    for (const entry of friendEntries) {
      if (!entry.user_id) continue;
      counts.set(entry.user_id, (counts.get(entry.user_id) ?? 0) + 1);
    }

    return counts.size ? Math.max(...counts.values()) : 0;
  }

  /** Number of events where the user attended alongside at least `minFriendsPresent` friends. */
  private async computeGroupCoattendanceEvents(
    userId: string,
    minFriendsPresent: number,
  ): Promise<number> {
    const [myEntries, friendIds] = await Promise.all([
      this.prisma.entries.findMany({
        where: { user_id: userId },
        select: { event_id: true },
      }),
      this.prisma.friendships.findMany({
        where: { user_id: userId },
        select: { friend_id: true },
      }),
    ]);

    if (friendIds.length === 0 || myEntries.length === 0) return 0;

    const friendIdSet = new Set(friendIds.map((f) => f.friend_id));
    const friendEntries = await this.prisma.entries.findMany({
      where: {
        event_id: { in: myEntries.map((e) => e.event_id) },
        user_id: { in: Array.from(friendIdSet) },
      },
      select: { event_id: true, user_id: true },
    });

    const friendsPerEvent = new Map<string, Set<string>>();
    for (const entry of friendEntries) {
      if (!entry.user_id) continue;
      if (!friendsPerEvent.has(entry.event_id))
        friendsPerEvent.set(entry.event_id, new Set());
      friendsPerEvent.get(entry.event_id)!.add(entry.user_id);
    }

    let qualifyingEvents = 0;
    for (const friendsPresent of friendsPerEvent.values()) {
      if (friendsPresent.size >= minFriendsPresent) qualifyingEvents += 1;
    }
    return qualifyingEvents;
  }
}
