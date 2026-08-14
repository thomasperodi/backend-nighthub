import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { BadgesService } from '../badges/badges.service';
import { PushDispatchService } from '../common/push/push-dispatch.service';

@Injectable()
export class FriendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
    private readonly badgesService: BadgesService,
    private readonly pushDispatch: PushDispatchService,
  ) {}
  private readonly logger = new Logger(FriendsService.name);

  private evaluateBadges(userId: string | null | undefined) {
    if (!userId) return;
    void this.badgesService.evaluateForUser(userId).catch((error) => {
      this.logger.error(
        `Badge evaluation failed for user ${userId}`,
        error instanceof Error ? error.stack : undefined,
      );
    });
  }
  private readonly onlineActivityMinutes = 2;
  private readonly staleLocationMinutes = 30;
  private readonly hideLocationAfterHours = 24 * 7;
  private readonly hotspotMinFriends = 2;
  private readonly nearbyVenueMultiplier = 1.5;

  private decimalToNumber(
    value: Prisma.Decimal | number | string | null | undefined,
  ) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }
    if (typeof value.toNumber === 'function') {
      const numeric = value.toNumber();
      return Number.isFinite(numeric) ? numeric : null;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private calculateDistanceMeters(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ) {
    const earthRadiusKm = 6371;
    const deltaLat = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(deltaLon / 2) *
        Math.sin(deltaLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusKm * c * 1000;
  }

  private getUserDisplayName(user: {
    name?: string | null;
    username?: string | null;
  }) {
    return user.name || user.username || 'Amico';
  }

  private inferVenuePresence(params: {
    latitude: number;
    longitude: number;
    openStay?: any;
    venues: Array<{
      id: string;
      name: string;
      latitude: number;
      longitude: number;
      radius_geofence: number;
    }>;
  }) {
    if (params.openStay?.venue) {
      const venueLatitude = this.decimalToNumber(
        params.openStay.venue.latitude,
      );
      const venueLongitude = this.decimalToNumber(
        params.openStay.venue.longitude,
      );
      const radiusMeters = Number(params.openStay.venue.radius_geofence ?? 100);
      const distanceMeters =
        venueLatitude !== null && venueLongitude !== null
          ? this.calculateDistanceMeters(
              params.latitude,
              params.longitude,
              venueLatitude,
              venueLongitude,
            )
          : null;

      return {
        type: 'inside' as const,
        venue_id: params.openStay.venue.id,
        venue_name: params.openStay.venue.name,
        radius_meters: radiusMeters,
        distance_meters:
          distanceMeters === null ? null : Math.round(distanceMeters),
        entered_at: params.openStay.entered_at,
      };
    }

    let nearestVenue: (typeof params.venues)[number] | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const venue of params.venues) {
      const distance = this.calculateDistanceMeters(
        params.latitude,
        params.longitude,
        venue.latitude,
        venue.longitude,
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestVenue = venue;
      }
    }

    if (!nearestVenue) return null;

    const radiusMeters = Number(nearestVenue.radius_geofence ?? 100);
    const maxNearbyDistance = Math.max(
      radiusMeters * this.nearbyVenueMultiplier,
      140,
    );

    if (nearestDistance > maxNearbyDistance) {
      return null;
    }

    return {
      type:
        nearestDistance <= radiusMeters
          ? ('inside' as const)
          : ('nearby' as const),
      venue_id: nearestVenue.id,
      venue_name: nearestVenue.name,
      radius_meters: radiusMeters,
      distance_meters: Math.round(nearestDistance),
      entered_at: null,
    };
  }

  private async notifyUsersAddedToGroup(params: {
    ownerId: string;
    groupId: string;
    groupName: string;
    memberIds: string[];
  }) {
    const uniqueMemberIds = Array.from(
      new Set(
        (params.memberIds ?? []).filter((id) => id && id !== params.ownerId),
      ),
    );
    if (uniqueMemberIds.length === 0) return;

    const owner = await this.prisma.users.findUnique({
      where: { id: params.ownerId },
      select: { name: true, username: true },
    });

    const ownerDisplayName = owner?.name || owner?.username || 'Un tuo amico';

    await Promise.allSettled(
      uniqueMemberIds.map((memberId) =>
        this.pushDispatch.notifyUser(memberId, {
          title: 'Nuovo gruppo amici',
          body: `${ownerDisplayName} ti ha aggiunto al gruppo "${params.groupName}".`,
          data: {
            type: 'friend_group_added',
            group_id: params.groupId,
            added_by_user_id: params.ownerId,
          },
        }),
      ),
    );
  }

  async searchUsers(query: string, currentUserId: string) {
    const q = String(query || '')
      .trim()
      .toLowerCase();
    if (!q) return [];
    if (q.length < 2) {
      throw new BadRequestException('query must be at least 2 characters');
    }

    const [currentUserFriendLinks, candidates] = await this.prisma.$transaction(
      [
        this.prisma.friendships.findMany({
          where: { user_id: currentUserId },
          select: { friend_id: true },
        }),
        this.prisma.users.findMany({
          where: {
            id: { not: currentUserId },
            // Social search must never surface staff/venue/admin accounts (impersonation
            // risk) or suspended/deactivated users - both are enforced here, not just in
            // the frontend, since the frontend filter is trivially bypassed by calling
            // this endpoint directly.
            role: 'client',
            is_active: true,
            OR: [
              { username: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          },
          select: {
            id: true,
            username: true,
            name: true,
            avatar: true,
          },
          take: 20,
        }),
      ],
    );

    if (candidates.length === 0) return [];

    const candidateIds = candidates.map((candidate) => candidate.id);
    const verifiedPrCandidates = await this.prisma.venue_pr_memberships.findMany(
      {
        where: { user_id: { in: candidateIds }, is_active: true },
        select: { user_id: true },
      },
    );
    const verifiedPrCandidateIds = new Set(
      verifiedPrCandidates.map((m) => m.user_id),
    );

    const currentUserFriendIds = Array.from(
      new Set(
        currentUserFriendLinks
          .map((link) => String(link.friend_id))
          .filter(Boolean),
      ),
    );

    if (currentUserFriendIds.length === 0) {
      return candidates.map((candidate) => ({
        ...candidate,
        is_verified_pr: verifiedPrCandidateIds.has(candidate.id),
        mutual_friends_count: 0,
        mutual_friends_ids: [] as string[],
        mutual_friends: [] as Array<{
          id: string;
          username: string | null;
          name: string | null;
          avatar: string | null;
        }>,
      }));
    }
    const candidateMutualLinks = await this.prisma.friendships.findMany({
      where: {
        user_id: { in: candidateIds },
        friend_id: { in: currentUserFriendIds },
      },
      select: {
        user_id: true,
        friend_id: true,
      },
    });

    const mutualIdsByCandidate = new Map<string, string[]>();
    for (const link of candidateMutualLinks) {
      const candidateId = String(link.user_id);
      const friendId = String(link.friend_id);
      const existing = mutualIdsByCandidate.get(candidateId) ?? [];
      existing.push(friendId);
      mutualIdsByCandidate.set(candidateId, existing);
    }

    const allMutualIds = Array.from(
      new Set(
        candidateMutualLinks
          .map((link) => String(link.friend_id))
          .filter(Boolean),
      ),
    );

    const mutualProfiles = allMutualIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: allMutualIds } },
          select: {
            id: true,
            username: true,
            name: true,
            avatar: true,
          },
          orderBy: { name: 'asc' },
        })
      : [];

    const profileById = new Map(
      mutualProfiles.map((profile) => [profile.id, profile] as const),
    );

    return candidates.map((candidate) => {
      const mutualIdsRaw = mutualIdsByCandidate.get(candidate.id) ?? [];
      const mutualIds = Array.from(new Set(mutualIdsRaw));
      const mutualFriendProfiles = mutualIds
        .map((id) => profileById.get(id))
        .filter((profile): profile is (typeof mutualProfiles)[number] =>
          Boolean(profile),
        );

      return {
        ...candidate,
        is_verified_pr: verifiedPrCandidateIds.has(candidate.id),
        mutual_friends_count: mutualIds.length,
        mutual_friends_ids: mutualIds,
        mutual_friends: mutualFriendProfiles,
      };
    });
  }

  async listFriends(userId: string) {
    const links = await this.prisma.friendships.findMany({
      where: { user_id: userId },
      select: { friend_id: true },
    });
    const friendIds = links.map((l) => l.friend_id);
    if (friendIds.length === 0) return [];

    const prismaAny = this.prisma as any;
    const [friends, openStays, allVenuesRaw, verifiedPrMemberships] =
      await Promise.all([
      prismaAny.users.findMany({
        where: { id: { in: friendIds } },
        select: {
          id: true,
          username: true,
          name: true,
          avatar: true,
          location_sharing_enabled: true,
          last_latitude: true,
          last_longitude: true,
          last_location_accuracy_meters: true,
          last_location_updated_at: true,
          last_active_at: true,
        },
      }),
      prismaAny.venue_stays.findMany({
        where: {
          user_id: { in: friendIds },
          exited_at: null,
        },
        orderBy: { entered_at: 'desc' },
        select: {
          user_id: true,
          entered_at: true,
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
      }),
      prismaAny.venues.findMany({
        where: {
          latitude: { not: null },
          longitude: { not: null },
        },
        select: {
          id: true,
          name: true,
          latitude: true,
          longitude: true,
          radius_geofence: true,
        },
      }),
      // Server-derived PR verification badge (see PublicUser.is_verified_pr) - never trust
      // this from the client, always recomputed from the actual membership table.
      this.prisma.venue_pr_memberships.findMany({
        where: { user_id: { in: friendIds }, is_active: true },
        select: { user_id: true },
      }),
    ]);

    const verifiedPrUserIds = new Set(
      verifiedPrMemberships.map((m: { user_id: string }) => m.user_id),
    );

    const allVenues = allVenuesRaw
      .map((venue: any) => ({
        ...venue,
        latitude: this.decimalToNumber(venue.latitude),
        longitude: this.decimalToNumber(venue.longitude),
        radius_geofence: Number(venue.radius_geofence ?? 100),
      }))
      .filter(
        (
          venue: any,
        ): venue is {
          id: string;
          name: string;
          latitude: number;
          longitude: number;
          radius_geofence: number;
        } => venue.latitude !== null && venue.longitude !== null,
      );

    const openStayByUserId = new Map<string, any>();
    for (const stay of openStays) {
      if (!openStayByUserId.has(stay.user_id)) {
        openStayByUserId.set(stay.user_id, stay);
      }
    }

    const now = Date.now();
    const staleMs = this.staleLocationMinutes * 60 * 1000;
    const hiddenAfterMs = this.hideLocationAfterHours * 60 * 60 * 1000;
    const onlineMs = this.onlineActivityMinutes * 60 * 1000;

    return friends
      .map((friend: any) => {
        const latitude = this.decimalToNumber(friend.last_latitude);
        const longitude = this.decimalToNumber(friend.last_longitude);
        const locationUpdatedAt = friend.last_location_updated_at
          ? new Date(friend.last_location_updated_at)
          : null;
        const locationUpdatedAtMs = locationUpdatedAt?.getTime() ?? null;
        const locationAgeMs =
          locationUpdatedAtMs === null
            ? null
            : Math.max(0, now - locationUpdatedAtMs);
        const locationLastSeenMinutes =
          locationAgeMs === null ? null : Math.round(locationAgeMs / 60000);
        const isLocationExpired =
          locationAgeMs !== null && locationAgeMs > hiddenAfterMs;
        const hasShareableLocation =
          Boolean(friend.location_sharing_enabled) &&
          latitude !== null &&
          longitude !== null &&
          !isLocationExpired;

        const venuePresence = hasShareableLocation
          ? this.inferVenuePresence({
              latitude,
              longitude,
              openStay: openStayByUserId.get(friend.id),
              venues: allVenues,
            })
          : null;

        const lastActiveAt = friend.last_active_at
          ? new Date(friend.last_active_at)
          : null;
        const lastActiveMs = lastActiveAt?.getTime() ?? null;
        const activityAgeMs =
          lastActiveMs === null ? null : Math.max(0, now - lastActiveMs);
        const lastActiveMinutes =
          activityAgeMs === null ? null : Math.round(activityAgeMs / 60000);
        const isOnline = activityAgeMs !== null && activityAgeMs <= onlineMs;

        return {
          id: friend.id,
          username: friend.username,
          name: friend.name,
          avatar: friend.avatar,
          online: isOnline,
          current_venue: venuePresence?.venue_name ?? null,
          presence_type: venuePresence?.type ?? null,
          status: venuePresence
            ? venuePresence.type === 'nearby'
              ? 'Vicino al locale'
              : 'Nel locale'
            : isOnline
              ? 'Attivo ora'
              : null,
          last_active_at: lastActiveAt?.toISOString() ?? null,
          last_seen_at:
            (lastActiveAt ?? locationUpdatedAt)?.toISOString() ?? null,
          last_seen_minutes_ago: isOnline
            ? 0
            : (lastActiveMinutes ?? locationLastSeenMinutes),
          sharing_enabled: Boolean(friend.location_sharing_enabled),
          is_stale: locationAgeMs === null ? true : locationAgeMs > staleMs,
          is_verified_pr: verifiedPrUserIds.has(friend.id),
        };
      })
      .sort((left, right) => {
        if (left.online !== right.online) {
          return left.online ? -1 : 1;
        }

        const leftName = String(
          left.name || left.username || '',
        ).toLocaleLowerCase();
        const rightName = String(
          right.name || right.username || '',
        ).toLocaleLowerCase();
        return leftName.localeCompare(rightName, 'it');
      });
  }

  async updateLocationSharing(userId: string, enabled: boolean) {
    const prismaAny = this.prisma as any;

    const updated = await prismaAny.users.update({
      where: { id: userId },
      data: enabled
        ? { location_sharing_enabled: true }
        : {
            location_sharing_enabled: false,
            last_latitude: null,
            last_longitude: null,
            last_location_accuracy_meters: null,
            last_location_updated_at: null,
          },
      select: {
        id: true,
        location_sharing_enabled: true,
        last_location_updated_at: true,
      },
    });

    return {
      user_id: updated.id,
      sharing_enabled: Boolean(updated.location_sharing_enabled),
      last_location_updated_at: updated.last_location_updated_at,
    };
  }

  async updateLocation(
    userId: string,
    params: {
      latitude: number;
      longitude: number;
      accuracy?: number;
      timestamp?: string;
    },
  ) {
    const prismaAny = this.prisma as any;
    const user = await prismaAny.users.findUnique({
      where: { id: userId },
      select: { id: true, location_sharing_enabled: true },
    });

    if (!user) throw new NotFoundException('User not found');

    if (!user.location_sharing_enabled) {
      return {
        user_id: userId,
        sharing_enabled: false,
        location_updated_at: null,
      };
    }

    const observedAt = params.timestamp
      ? new Date(params.timestamp)
      : new Date();
    if (Number.isNaN(observedAt.getTime())) {
      throw new BadRequestException('timestamp must be ISO8601');
    }

    const updated = await prismaAny.users.update({
      where: { id: userId },
      data: {
        last_latitude: new Prisma.Decimal(params.latitude.toFixed(6)),
        last_longitude: new Prisma.Decimal(params.longitude.toFixed(6)),
        last_location_accuracy_meters:
          params.accuracy === undefined ? null : Math.round(params.accuracy),
        last_location_updated_at: observedAt,
      },
      select: {
        id: true,
        location_sharing_enabled: true,
        last_location_updated_at: true,
      },
    });

    return {
      user_id: updated.id,
      sharing_enabled: Boolean(updated.location_sharing_enabled),
      location_updated_at: updated.last_location_updated_at,
    };
  }

  async getMapPresence(userId: string) {
    const prismaAny = this.prisma as any;
    type MapVenue = {
      id: string;
      name: string;
      latitude: number;
      longitude: number;
      radius_geofence: number;
    };
    type PresenceFriendSummary = {
      id: string;
      name: string;
      avatar?: string | null;
    };
    type VenuePresenceAggregate = {
      venue_id: string;
      venue_name: string;
      friend_count: number;
      friends: PresenceFriendSummary[];
    };
    type HotspotSummary = {
      venue_id: string;
      venue_name: string;
      latitude: number;
      longitude: number;
      radius_meters: number;
      friend_count: number;
      active_event_count: number;
      upcoming_event_count: number;
      vibe: 'hot' | 'warm';
      friends: PresenceFriendSummary[];
    };

    const [me, links] = await Promise.all([
      prismaAny.users.findUnique({
        where: { id: userId },
        select: {
          id: true,
          location_sharing_enabled: true,
          last_location_updated_at: true,
        },
      }),
      this.prisma.friendships.findMany({
        where: { user_id: userId },
        select: { friend_id: true },
      }),
    ]);

    const friendIds = links.map((link) => link.friend_id).filter(Boolean);
    if (friendIds.length === 0) {
      return {
        sharing_enabled: Boolean(me?.location_sharing_enabled),
        my_last_location_updated_at: me?.last_location_updated_at ?? null,
        friends: [],
        hotspots: [],
      };
    }

    const [friends, openStays, allVenuesRaw] = await Promise.all([
      prismaAny.users.findMany({
        where: { id: { in: friendIds } },
        select: {
          id: true,
          username: true,
          name: true,
          avatar: true,
          location_sharing_enabled: true,
          last_latitude: true,
          last_longitude: true,
          last_location_accuracy_meters: true,
          last_location_updated_at: true,
        },
        orderBy: [{ name: 'asc' }, { username: 'asc' }],
      }),
      prismaAny.venue_stays.findMany({
        where: {
          user_id: { in: friendIds },
          exited_at: null,
        },
        orderBy: { entered_at: 'desc' },
        select: {
          user_id: true,
          entered_at: true,
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
      }),
      prismaAny.venues.findMany({
        where: {
          latitude: { not: null },
          longitude: { not: null },
        },
        select: {
          id: true,
          name: true,
          latitude: true,
          longitude: true,
          radius_geofence: true,
        },
      }),
    ]);

    const allVenues: MapVenue[] = allVenuesRaw
      .map((venue: any) => ({
        ...venue,
        latitude: this.decimalToNumber(venue.latitude),
        longitude: this.decimalToNumber(venue.longitude),
        radius_geofence: Number(venue.radius_geofence ?? 100),
      }))
      .filter(
        (venue: any): venue is MapVenue =>
          venue.latitude !== null && venue.longitude !== null,
      );

    const openStayByUserId = new Map<string, any>();
    for (const stay of openStays) {
      if (!openStayByUserId.has(stay.user_id)) {
        openStayByUserId.set(stay.user_id, stay);
      }
    }

    const now = Date.now();
    const staleMs = this.staleLocationMinutes * 60 * 1000;
    const hiddenAfterMs = this.hideLocationAfterHours * 60 * 60 * 1000;

    const friendPresenceMap = new Map<string, VenuePresenceAggregate>();

    const mappedFriends = friends.map((friend: any) => {
      const latitude = this.decimalToNumber(friend.last_latitude);
      const longitude = this.decimalToNumber(friend.last_longitude);
      const updatedAt = friend.last_location_updated_at
        ? new Date(friend.last_location_updated_at)
        : null;
      const updatedAtMs = updatedAt?.getTime() ?? null;
      const ageMs =
        updatedAtMs === null ? null : Math.max(0, now - updatedAtMs);
      const lastSeenMinutes = ageMs === null ? null : Math.round(ageMs / 60000);
      const isExpired = ageMs !== null && ageMs > hiddenAfterMs;
      const hasShareableLocation =
        Boolean(friend.location_sharing_enabled) &&
        latitude !== null &&
        longitude !== null &&
        !isExpired;

      const venuePresence = hasShareableLocation
        ? this.inferVenuePresence({
            latitude,
            longitude,
            openStay: openStayByUserId.get(friend.id),
            venues: allVenues,
          })
        : null;

      if (venuePresence) {
        const existing: VenuePresenceAggregate = friendPresenceMap.get(
          venuePresence.venue_id,
        ) ?? {
          venue_id: venuePresence.venue_id,
          venue_name: venuePresence.venue_name,
          friend_count: 0,
          friends: [],
        };
        existing.friend_count += 1;
        existing.friends.push({
          id: friend.id,
          name: this.getUserDisplayName(friend),
          avatar: friend.avatar,
        });
        friendPresenceMap.set(venuePresence.venue_id, existing);
      }

      return {
        id: friend.id,
        username: friend.username,
        name: friend.name,
        avatar: friend.avatar,
        sharing_enabled: Boolean(friend.location_sharing_enabled),
        last_seen_at: updatedAt?.toISOString() ?? null,
        last_seen_minutes_ago: lastSeenMinutes,
        is_stale: ageMs === null ? true : ageMs > staleMs,
        position: hasShareableLocation
          ? {
              latitude,
              longitude,
              accuracy_meters:
                friend.last_location_accuracy_meters === null ||
                friend.last_location_accuracy_meters === undefined
                  ? null
                  : Number(friend.last_location_accuracy_meters),
            }
          : null,
        venue_presence: venuePresence,
      };
    });

    const hotspotVenueIds = Array.from(friendPresenceMap.keys());
    const hotspotEvents = hotspotVenueIds.length
      ? await prismaAny.events.findMany({
          where: {
            venue_id: { in: hotspotVenueIds },
            status: { in: ['LIVE', 'DRAFT'] },
          },
          select: {
            venue_id: true,
            status: true,
            date: true,
          },
        })
      : [];

    const eventCountsByVenueId = new Map<
      string,
      { active_event_count: number; upcoming_event_count: number }
    >();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    for (const event of hotspotEvents) {
      const current = eventCountsByVenueId.get(event.venue_id) ?? {
        active_event_count: 0,
        upcoming_event_count: 0,
      };
      if (String(event.status).toUpperCase() === 'LIVE') {
        current.active_event_count += 1;
      } else if (
        event.date &&
        new Date(event.date).getTime() >= startOfToday.getTime()
      ) {
        current.upcoming_event_count += 1;
      }
      eventCountsByVenueId.set(event.venue_id, current);
    }

    const venueById = new Map<string, MapVenue>(
      allVenues.map((venue) => [venue.id, venue] as const),
    );
    const hotspots = Array.from(friendPresenceMap.values())
      .map<HotspotSummary | null>((presence) => {
        const venue = venueById.get(presence.venue_id);
        if (!venue) return null;
        const eventCounts = eventCountsByVenueId.get(presence.venue_id) ?? {
          active_event_count: 0,
          upcoming_event_count: 0,
        };

        return {
          venue_id: presence.venue_id,
          venue_name: presence.venue_name,
          latitude: venue.latitude,
          longitude: venue.longitude,
          radius_meters: venue.radius_geofence,
          friend_count: presence.friend_count,
          active_event_count: eventCounts.active_event_count,
          upcoming_event_count: eventCounts.upcoming_event_count,
          vibe:
            presence.friend_count >= 4 || eventCounts.active_event_count > 0
              ? 'hot'
              : 'warm',
          friends: presence.friends,
        };
      })
      .filter((hotspot): hotspot is HotspotSummary => {
        if (!hotspot) {
          return false;
        }

        return (
          hotspot.friend_count >= this.hotspotMinFriends &&
          hotspot.active_event_count + hotspot.upcoming_event_count > 0
        );
      })
      .sort((a, b) => {
        const scoreA =
          a.friend_count * 10 +
          a.active_event_count * 5 +
          a.upcoming_event_count;
        const scoreB =
          b.friend_count * 10 +
          b.active_event_count * 5 +
          b.upcoming_event_count;
        return scoreB - scoreA;
      });

    return {
      sharing_enabled: Boolean(me?.location_sharing_enabled),
      my_last_location_updated_at: me?.last_location_updated_at ?? null,
      friends: mappedFriends,
      hotspots,
    };
  }

  /** Friends with an active (non-cancelled) reservation for today's or an upcoming event, one entry per friend (their soonest event). */
  async getFriendsTonight(userId: string) {
    const links = await this.prisma.friendships.findMany({
      where: { user_id: userId },
      select: { friend_id: true },
    });
    const friendIds = links.map((link) => link.friend_id);
    if (friendIds.length === 0) return [];

    const today = new Date(new Date().toISOString().slice(0, 10));

    const reservations = await this.prisma.reservations.findMany({
      where: {
        user_id: { in: friendIds },
        status: { not: 'cancelled' },
        event: { date: { gte: today } },
      },
      orderBy: { event: { date: 'asc' } },
      select: {
        user_id: true,
        event: {
          select: {
            id: true,
            name: true,
            date: true,
            venue: { select: { id: true, name: true, image: true } },
          },
        },
      },
    });

    const soonestByUser = new Map<string, (typeof reservations)[number]>();
    for (const reservation of reservations) {
      if (!soonestByUser.has(reservation.user_id)) {
        soonestByUser.set(reservation.user_id, reservation);
      }
    }
    if (soonestByUser.size === 0) return [];

    const friends = await this.prisma.users.findMany({
      where: { id: { in: Array.from(soonestByUser.keys()) } },
      select: { id: true, username: true, name: true, avatar: true },
    });

    return friends.map((friend) => {
      const reservation = soonestByUser.get(friend.id)!;
      return {
        ...friend,
        event_id: reservation.event.id,
        event_name: reservation.event.name,
        venue_id: reservation.event.venue.id,
        venue_name: reservation.event.venue.name,
      };
    });
  }

  async listRequests(userId: string) {
    const [incoming, outgoing] = await this.prisma.$transaction([
      this.prisma.friend_requests.findMany({
        where: { to_user_id: userId, status: 'pending' },
        orderBy: { created_at: 'desc' },
        include: {
          from_user: {
            select: { id: true, username: true, name: true, avatar: true },
          },
        },
      }),
      this.prisma.friend_requests.findMany({
        where: { from_user_id: userId, status: 'pending' },
        orderBy: { created_at: 'desc' },
        include: {
          to_user: {
            select: { id: true, username: true, name: true, avatar: true },
          },
        },
      }),
    ]);

    return { incoming, outgoing };
  }

  async sendRequest(params: {
    from_user_id: string;
    username?: string;
    user_id?: string;
  }) {
    const { from_user_id, username, user_id } = params;

    let target = null as { id: string } | null;
    if (user_id) {
      target = await this.prisma.users.findUnique({
        where: { id: user_id },
        select: { id: true },
      });
    } else if (username) {
      target = await this.prisma.users.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
        select: { id: true },
      });
    }

    if (!target) throw new NotFoundException('User not found');
    if (target.id === from_user_id)
      throw new BadRequestException('Cannot add yourself');

    const [existingFriend, existingRequest] = await Promise.all([
      this.prisma.friendships.findFirst({
        where: { user_id: from_user_id, friend_id: target.id },
        select: { id: true },
      }),
      this.prisma.friend_requests.findFirst({
        where: {
          from_user_id,
          to_user_id: target.id,
        },
        select: { id: true, status: true },
      }),
    ]);
    if (existingFriend) return { alreadyFriends: true };
    if (existingRequest?.status === 'pending')
      return { alreadyRequested: true };
    if (existingRequest?.status === 'accepted') return { alreadyFriends: true };

    let createdRequest: { id: string };

    if (existingRequest?.status === 'rejected') {
      createdRequest = await this.prisma.friend_requests.update({
        where: { id: existingRequest.id },
        data: { status: 'pending' },
        select: { id: true },
      });
    } else {
      try {
        createdRequest = await this.prisma.friend_requests.create({
          data: {
            from_user_id,
            to_user_id: target.id,
            status: 'pending',
          },
          select: { id: true },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const conflicted = await this.prisma.friend_requests.findFirst({
            where: {
              from_user_id,
              to_user_id: target.id,
            },
            select: { id: true, status: true },
          });

          if (!conflicted) throw error;
          if (conflicted.status === 'pending')
            return { alreadyRequested: true };
          if (conflicted.status === 'accepted') return { alreadyFriends: true };

          createdRequest = await this.prisma.friend_requests.update({
            where: { id: conflicted.id },
            data: { status: 'pending' },
            select: { id: true },
          });
        } else {
          throw error;
        }
      }
    }

    const fromUser = await this.prisma.users.findUnique({
      where: { id: from_user_id },
      select: { name: true, username: true },
    });

    const senderDisplayName =
      fromUser?.name || fromUser?.username || 'Un utente';
    await this.pushDispatch.notifyUser(target.id, {
      title: 'Nuova richiesta di amicizia',
      body: `${senderDisplayName} ti ha inviato una richiesta di amicizia.`,
      data: {
        type: 'friend_request_received',
        request_id: createdRequest.id,
        from_user_id,
      },
    });

    return createdRequest;
  }

  async acceptRequest(requestId: string, userId: string) {
    const request = await this.prisma.friend_requests.findUnique({
      where: { id: requestId },
    });
    if (!request || request.to_user_id !== userId) {
      throw new NotFoundException('Request not found');
    }

    if (request.status !== 'pending') return request;

    await this.prisma.$transaction([
      this.prisma.friend_requests.update({
        where: { id: requestId },
        data: { status: 'accepted' },
      }),
      this.prisma.friendships.create({
        data: { user_id: request.from_user_id, friend_id: request.to_user_id },
      }),
      this.prisma.friendships.create({
        data: { user_id: request.to_user_id, friend_id: request.from_user_id },
      }),
    ]);

    this.evaluateBadges(request.from_user_id);
    this.evaluateBadges(request.to_user_id);

    const acceptingUser = await this.prisma.users.findUnique({
      where: { id: request.to_user_id },
      select: { name: true, username: true },
    });

    const accepterDisplayName =
      acceptingUser?.name || acceptingUser?.username || 'Un utente';
    await this.pushDispatch.notifyUser(request.from_user_id, {
      title: 'Richiesta accettata',
      body: `${accepterDisplayName} ha accettato la tua richiesta di amicizia.`,
      data: {
        type: 'friend_request_accepted',
        request_id: requestId,
        from_user_id: request.to_user_id,
      },
    });

    return { success: true };
  }

  async rejectRequest(requestId: string, userId: string) {
    const request = await this.prisma.friend_requests.findUnique({
      where: { id: requestId },
    });
    if (!request || request.to_user_id !== userId) {
      throw new NotFoundException('Request not found');
    }

    await this.prisma.friend_requests.update({
      where: { id: requestId },
      data: { status: 'rejected' },
    });

    return { success: true };
  }

  async removeFriend(userId: string, friendId: string) {
    await this.prisma.$transaction([
      this.prisma.friendships.deleteMany({
        where: { user_id: userId, friend_id: friendId },
      }),
      this.prisma.friendships.deleteMany({
        where: { user_id: friendId, friend_id: userId },
      }),
    ]);

    return { success: true };
  }

  async listGroups(userId: string) {
    return this.prisma.friend_groups.findMany({
      where: {
        OR: [{ owner_id: userId }, { members: { some: { user_id: userId } } }],
      },
      orderBy: { created_at: 'desc' },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true, name: true, avatar: true },
            },
          },
        },
      },
    });
  }

  async createGroup(params: {
    owner_id: string;
    name: string;
    member_ids?: string[];
  }) {
    const name = String(params.name || '').trim();
    if (!name) throw new BadRequestException('name required');

    const memberIds = Array.from(
      new Set(
        (params.member_ids ?? []).filter((id) => id && id !== params.owner_id),
      ),
    );

    const existingMembers = memberIds.length
      ? await this.prisma.users.findMany({
          where: { id: { in: memberIds } },
          select: { id: true },
        })
      : [];

    const existingMemberIds = new Set(existingMembers.map((user) => user.id));
    const missingMemberIds = memberIds.filter(
      (id) => !existingMemberIds.has(id),
    );
    if (missingMemberIds.length > 0) {
      throw new BadRequestException({
        message: 'Some member_ids are invalid',
        invalid_member_ids: missingMemberIds,
      });
    }

    const group = await this.prisma.friend_groups.create({
      data: {
        name,
        owner_id: params.owner_id,
        members: {
          create: memberIds.map((id) => ({ user_id: id })),
        },
      },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, username: true, name: true, avatar: true },
            },
          },
        },
      },
    });

    await this.notifyUsersAddedToGroup({
      ownerId: params.owner_id,
      groupId: group.id,
      groupName: group.name,
      memberIds,
    });

    return group;
  }

  async updateGroup(params: {
    group_id: string;
    owner_id: string;
    name?: string;
  }) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: params.group_id },
    });
    if (!group || group.owner_id !== params.owner_id) {
      throw new NotFoundException('Group not found');
    }

    const name = params.name ? String(params.name).trim() : undefined;

    return this.prisma.friend_groups.update({
      where: { id: params.group_id },
      data: { name: name || undefined },
    });
  }

  async deleteGroup(params: { group_id: string; owner_id: string }) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: params.group_id },
    });
    if (!group || group.owner_id !== params.owner_id) {
      throw new NotFoundException('Group not found');
    }

    await this.prisma.friend_groups.delete({ where: { id: params.group_id } });
    return { success: true };
  }

  async addGroupMember(params: {
    group_id: string;
    owner_id: string;
    user_id: string;
  }) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: params.group_id },
    });
    if (!group || group.owner_id !== params.owner_id) {
      throw new NotFoundException('Group not found');
    }

    const memberUser = await this.prisma.users.findUnique({
      where: { id: params.user_id },
      select: { id: true },
    });
    if (!memberUser) {
      throw new NotFoundException('User not found');
    }

    const existingMembership = await this.prisma.friend_group_members.findFirst(
      {
        where: { group_id: params.group_id, user_id: params.user_id },
      },
    );
    if (existingMembership) {
      return existingMembership;
    }

    const member = await this.prisma.friend_group_members.create({
      data: {
        group_id: params.group_id,
        user_id: params.user_id,
      },
    });

    await this.notifyUsersAddedToGroup({
      ownerId: params.owner_id,
      groupId: group.id,
      groupName: group.name,
      memberIds: [params.user_id],
    });

    return member;
  }

  async removeGroupMember(params: {
    group_id: string;
    owner_id: string;
    user_id: string;
  }) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: params.group_id },
    });
    if (!group || group.owner_id !== params.owner_id) {
      throw new NotFoundException('Group not found');
    }

    await this.prisma.friend_group_members.deleteMany({
      where: { group_id: params.group_id, user_id: params.user_id },
    });
    return { success: true };
  }

  private async getGroupWithAccess(groupId: string, userId: string) {
    const group = await this.prisma.friend_groups.findUnique({
      where: { id: groupId },
      include: {
        members: {
          select: {
            user_id: true,
            user: {
              select: { id: true, username: true, name: true, avatar: true },
            },
          },
        },
      },
    });

    if (!group) throw new NotFoundException('Group not found');

    const isOwner = group.owner_id === userId;
    const isMember = group.members.some((member) => member.user_id === userId);
    if (!isOwner && !isMember) throw new ForbiddenException('Forbidden');

    return { group, isOwner, isMember };
  }

  private toProposalStatus(
    votes: Array<{ vote: 'yes' | 'no' | 'pending' }>,
  ): 'voting' | 'ready' {
    const pending = votes.some((vote) => vote.vote === 'pending');
    const yesCount = votes.filter((vote) => vote.vote === 'yes').length;
    if (!pending && yesCount > 0) return 'ready';
    return 'voting';
  }

  private formatProposal(proposal: any) {
    const yes = proposal.votes.filter(
      (vote: any) => vote.vote === 'yes',
    ).length;
    const no = proposal.votes.filter((vote: any) => vote.vote === 'no').length;
    const pending = proposal.votes.filter(
      (vote: any) => vote.vote === 'pending',
    ).length;

    return {
      id: proposal.id,
      group_id: proposal.group_id,
      status: proposal.status,
      guests: proposal.guests,
      note: proposal.note,
      created_at: proposal.created_at,
      updated_at: proposal.updated_at,
      created_by_user: proposal.created_by_user,
      event: proposal.event,
      venue: proposal.venue,
      booked_reservation: proposal.booked_reservation,
      votes: proposal.votes,
      vote_stats: { yes, no, pending },
    };
  }

  private async resolveBookableEventForVenue(venueId: string) {
    const live = await this.prisma.events.findFirst({
      where: { venue_id: venueId, status: 'LIVE' },
      orderBy: [{ date: 'desc' }, { created_at: 'desc' }],
      select: {
        id: true,
        venue_id: true,
        name: true,
        date: true,
        status: true,
      },
    });
    if (live) return live;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const next = await this.prisma.events.findFirst({
      where: {
        venue_id: venueId,
        status: { in: ['DRAFT', 'LIVE'] },
        date: { gte: today },
      },
      orderBy: [{ date: 'asc' }, { start_time: 'asc' }, { created_at: 'asc' }],
      select: {
        id: true,
        venue_id: true,
        name: true,
        date: true,
        status: true,
      },
    });

    if (next) return next;

    throw new BadRequestException(
      'Nessun evento prenotabile trovato per questo locale',
    );
  }

  async listGroupTableProposals(groupId: string, userId: string) {
    await this.getGroupWithAccess(groupId, userId);

    const prismaAny = this.prisma as any;
    const proposals = await prismaAny.group_table_proposals.findMany({
      where: { group_id: groupId },
      orderBy: { created_at: 'desc' },
      include: {
        created_by_user: {
          select: { id: true, username: true, name: true, avatar: true },
        },
        event: {
          select: {
            id: true,
            name: true,
            date: true,
            start_time: true,
            end_time: true,
            status: true,
          },
        },
        venue: { select: { id: true, name: true, city: true, image: true } },
        booked_reservation: {
          select: { id: true, status: true, guests: true, created_at: true },
        },
        votes: {
          orderBy: { created_at: 'asc' },
          include: {
            user: {
              select: { id: true, username: true, name: true, avatar: true },
            },
          },
        },
      },
    });

    return proposals.map((proposal) => this.formatProposal(proposal));
  }

  async createGroupTableProposal(params: {
    group_id: string;
    user_id: string;
    venue_id: string;
    event_id?: string;
    guests: number;
    note?: string;
  }) {
    const guests = Number(params.guests);
    if (!Number.isInteger(guests) || guests < 2) {
      throw new BadRequestException('guests must be an integer >= 2');
    }

    const { group } = await this.getGroupWithAccess(
      params.group_id,
      params.user_id,
    );
    const venue = await this.prisma.venues.findUnique({
      where: { id: params.venue_id },
      select: { id: true, name: true },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    let event: Awaited<
      ReturnType<FriendsService['resolveBookableEventForVenue']>
    >;
    if (params.event_id) {
      const found = await (this.prisma as any).events.findUnique({
        where: { id: params.event_id },
        select: {
          id: true,
          venue_id: true,
          name: true,
          date: true,
          status: true,
        },
      });
      if (!found || found.venue_id !== params.venue_id) {
        throw new BadRequestException('Evento non valido per questo locale');
      }
      event = found;
    } else {
      event = await this.resolveBookableEventForVenue(params.venue_id);
    }
    const voterIds = Array.from(
      new Set([
        group.owner_id,
        ...group.members.map((member) => member.user_id),
      ]),
    );

    const proposal = await this.prisma.$transaction(async (tx) => {
      const created = await (tx as any).group_table_proposals.create({
        data: {
          group_id: params.group_id,
          created_by_user_id: params.user_id,
          event_id: event.id,
          venue_id: venue.id,
          guests,
          note: params.note?.trim() || null,
          status: 'voting',
        },
      });

      await (tx as any).group_table_proposal_votes.createMany({
        data: voterIds.map((voterId) => ({
          proposal_id: created.id,
          user_id: voterId,
          vote: voterId === params.user_id ? 'yes' : 'pending',
        })),
      });

      const createdWithVotes = await (
        tx as any
      ).group_table_proposals.findUnique({
        where: { id: created.id },
        include: {
          created_by_user: {
            select: { id: true, username: true, name: true, avatar: true },
          },
          event: {
            select: {
              id: true,
              name: true,
              date: true,
              start_time: true,
              end_time: true,
              status: true,
            },
          },
          venue: { select: { id: true, name: true, city: true, image: true } },
          booked_reservation: {
            select: { id: true, status: true, guests: true, created_at: true },
          },
          votes: {
            orderBy: { created_at: 'asc' },
            include: {
              user: {
                select: { id: true, username: true, name: true, avatar: true },
              },
            },
          },
        },
      });

      if (!createdWithVotes) throw new NotFoundException('Proposal not found');
      return createdWithVotes;
    });

    return this.formatProposal(proposal);
  }

  async voteGroupTableProposal(params: {
    group_id: string;
    proposal_id: string;
    user_id: string;
    vote: 'yes' | 'no' | 'pending';
  }) {
    if (!['yes', 'no', 'pending'].includes(params.vote)) {
      throw new BadRequestException('Invalid vote');
    }

    await this.getGroupWithAccess(params.group_id, params.user_id);

    const prismaAny = this.prisma as any;
    const proposal = await prismaAny.group_table_proposals.findUnique({
      where: { id: params.proposal_id },
      include: {
        votes: true,
      },
    });
    if (!proposal || proposal.group_id !== params.group_id) {
      throw new NotFoundException('Proposal not found');
    }
    if (proposal.status === 'booked' || proposal.status === 'cancelled') {
      throw new BadRequestException('Proposal is closed');
    }

    const existingVote = proposal.votes.find(
      (vote) => vote.user_id === params.user_id,
    );
    if (!existingVote)
      throw new ForbiddenException('User cannot vote on this proposal');

    const updated = await this.prisma.$transaction(async (tx) => {
      await (tx as any).group_table_proposal_votes.update({
        where: {
          proposal_id_user_id: {
            proposal_id: params.proposal_id,
            user_id: params.user_id,
          },
        },
        data: { vote: params.vote },
      });

      const votes = await (tx as any).group_table_proposal_votes.findMany({
        where: { proposal_id: params.proposal_id },
        select: { vote: true },
      });

      const nextStatus = this.toProposalStatus(votes);
      await (tx as any).group_table_proposals.update({
        where: { id: params.proposal_id },
        data: { status: nextStatus },
      });

      return (tx as any).group_table_proposals.findUnique({
        where: { id: params.proposal_id },
        include: {
          created_by_user: {
            select: { id: true, username: true, name: true, avatar: true },
          },
          event: {
            select: {
              id: true,
              name: true,
              date: true,
              start_time: true,
              end_time: true,
              status: true,
            },
          },
          venue: { select: { id: true, name: true, city: true, image: true } },
          booked_reservation: {
            select: { id: true, status: true, guests: true, created_at: true },
          },
          votes: {
            orderBy: { created_at: 'asc' },
            include: {
              user: {
                select: { id: true, username: true, name: true, avatar: true },
              },
            },
          },
        },
      });
    });

    if (!updated) throw new NotFoundException('Proposal not found');
    return this.formatProposal(updated);
  }

  async bookGroupTableProposal(params: {
    group_id: string;
    proposal_id: string;
    user_id: string;
    table_name?: string;
  }) {
    const { group, isOwner } = await this.getGroupWithAccess(
      params.group_id,
      params.user_id,
    );

    const prismaAny = this.prisma as any;
    const proposal = await prismaAny.group_table_proposals.findUnique({
      where: { id: params.proposal_id },
      include: {
        votes: true,
        event: { select: { id: true, venue_id: true } },
      },
    });

    if (!proposal || proposal.group_id !== params.group_id) {
      throw new NotFoundException('Proposal not found');
    }

    if (proposal.created_by_user_id !== params.user_id && !isOwner) {
      throw new ForbiddenException(
        'Only proposal creator or group owner can book',
      );
    }

    if (proposal.status === 'booked' && proposal.booked_reservation_id) {
      const existingReservation = await this.reservationsService.getReservation(
        proposal.booked_reservation_id,
      );
      return {
        reservation: existingReservation,
        proposal_id: proposal.id,
        already_booked: true,
      };
    }

    const yesVotes = proposal.votes.filter(
      (vote: any) => vote.vote === 'yes',
    ).length;
    if (yesVotes < 1) {
      throw new BadRequestException('Not enough yes votes to book');
    }

    const fallbackZone = await this.prisma.venue_table_zones.findFirst({
      where: { venue_id: proposal.event.venue_id, is_active: true },
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      select: { id: true },
    });
    if (!fallbackZone) {
      throw new BadRequestException('Nessuna zona disponibile per il locale');
    }

    const reservation = await this.reservationsService.createReservation({
      user_id: params.user_id,
      event_id: proposal.event_id,
      type: 'table',
      guests: yesVotes,
      venue_zone_id: fallbackZone.id,
      status: 'pending',
      table_name: params.table_name?.trim() || `Gruppo ${group.name}`,
    });

    await prismaAny.group_table_proposals.update({
      where: { id: params.proposal_id },
      data: {
        status: 'booked',
        booked_reservation_id: reservation.id,
      },
    });

    return {
      reservation,
      proposal_id: proposal.id,
      booked_guests: yesVotes,
    };
  }

  async cancelGroupTableProposal(params: {
    group_id: string;
    proposal_id: string;
    user_id: string;
  }) {
    const { isOwner } = await this.getGroupWithAccess(
      params.group_id,
      params.user_id,
    );

    const prismaAny = this.prisma as any;
    const proposal = await prismaAny.group_table_proposals.findUnique({
      where: { id: params.proposal_id },
      include: {
        created_by_user: {
          select: { id: true, username: true, name: true, avatar: true },
        },
        event: {
          select: {
            id: true,
            name: true,
            date: true,
            start_time: true,
            end_time: true,
            status: true,
          },
        },
        venue: { select: { id: true, name: true, city: true, image: true } },
        booked_reservation: {
          select: { id: true, status: true, guests: true, created_at: true },
        },
        votes: {
          orderBy: { created_at: 'asc' },
          include: {
            user: {
              select: { id: true, username: true, name: true, avatar: true },
            },
          },
        },
      },
    });

    if (!proposal || proposal.group_id !== params.group_id) {
      throw new NotFoundException('Proposal not found');
    }

    if (proposal.created_by_user_id !== params.user_id && !isOwner) {
      throw new ForbiddenException(
        'Only proposal creator or group owner can cancel',
      );
    }

    if (proposal.status === 'booked') {
      throw new BadRequestException('Booked proposal cannot be cancelled');
    }

    if (proposal.status === 'cancelled') {
      return this.formatProposal(proposal);
    }

    const updated = await prismaAny.group_table_proposals.update({
      where: { id: params.proposal_id },
      data: { status: 'cancelled' },
      include: {
        created_by_user: {
          select: { id: true, username: true, name: true, avatar: true },
        },
        event: {
          select: {
            id: true,
            name: true,
            date: true,
            start_time: true,
            end_time: true,
            status: true,
          },
        },
        venue: { select: { id: true, name: true, city: true, image: true } },
        booked_reservation: {
          select: { id: true, status: true, guests: true, created_at: true },
        },
        votes: {
          orderBy: { created_at: 'asc' },
          include: {
            user: {
              select: { id: true, username: true, name: true, avatar: true },
            },
          },
        },
      },
    });

    return this.formatProposal(updated);
  }
}
