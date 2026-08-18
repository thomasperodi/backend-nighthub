import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgeBucket, EntryMethod, Gender, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { resolveEntryUnitPrice } from '../common/entry-pricing';
import { BadgesService } from '../badges/badges.service';
import { PushDispatchService } from '../common/push/push-dispatch.service';
import { eventStartMs } from '../common/event-time.util';

type QrCheckInResult = {
  success: boolean;
  alreadyCheckedIn: boolean;
  reservation: unknown;
  entry?: unknown;
  checkedInGuests?: number;
};

type ParsedQrData = {
  qrToken?: string;
  reservationId?: string;
  userId?: string;
  eventId?: string;
  passType?: string;
  passId?: string;
  passVenueId?: string;
  passMembershipId?: string;
};

type PrSeasonPassLookupRow = {
  id: string;
  venue_id: string;
  pr_membership_id: string;
  user_id: string;
  status: 'active' | 'revoked' | 'expired';
  valid_from: Date;
  valid_until: Date;
  revoked_at: Date | null;
  qr_token: string;
  membership_is_active: boolean;
};

type TableInvitationStatus = 'pending' | 'accepted' | 'declined';

type TableInviteMetaItem = {
  user_id: string;
  status: TableInvitationStatus;
  source: 'direct' | 'group';
  invited_group_ids?: string[];
  responded_at?: string | null;
};

type TableReservationMeta = {
  booking_mode?: string;
  zone_label?: string;
  invited_friend_ids: string[];
  invited_group_ids: string[];
  inviter_user_id: string;
  inviter_name?: string;
  table_invites: TableInviteMetaItem[];
};

type ReservationReferralMeta = {
  inviter_user_id?: string;
  tracking_code?: string;
  pr_code?: string;
  ref_code?: string;
  promo_code?: string;
  pr_membership_id?: string;
  pr_role?: string;
  pr_omaggio_default?: boolean;
  wallet_pass_eligible?: boolean;
};

const incomingTableInvitationReservationSelect =
  Prisma.validator<Prisma.reservationsSelect>()({
    id: true,
    user_id: true,
    table_name: true,
    status: true,
    guests: true,
    total_amount: true,
    created_at: true,
    meta: true,
    user: { select: { id: true, name: true, username: true } },
    event: {
      select: {
        id: true,
        name: true,
        date: true,
        start_time: true,
        end_time: true,
        venue_id: true,
      },
    },
    venue_table_zone: {
      select: { id: true, name: true },
    },
  });

type IncomingTableInvitationReservation = Prisma.reservationsGetPayload<{
  select: typeof incomingTableInvitationReservationSelect;
}>;

const tableInvitationResponseReservationSelect =
  Prisma.validator<Prisma.reservationsSelect>()({
    id: true,
    user_id: true,
    table_name: true,
    status: true,
    guests: true,
    total_amount: true,
    created_at: true,
    meta: true,
    user: {
      select: { id: true, name: true, username: true, push_token: true },
    },
    event: {
      select: {
        id: true,
        name: true,
        date: true,
        start_time: true,
        end_time: true,
        venue_id: true,
      },
    },
    venue_table_zone: {
      select: { id: true, name: true },
    },
  });

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly badgesService: BadgesService,
    private readonly pushDispatch: PushDispatchService,
  ) {}

  private evaluateBadges(userId: string | null | undefined) {
    if (!userId) return;
    void this.badgesService.evaluateForUser(userId).catch((error) => {
      this.logger.error(
        `Badge evaluation failed for user ${userId}`,
        error instanceof Error ? error.stack : undefined,
      );
    });
  }
  private readonly logger = new Logger(ReservationsService.name);

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(
      new Set(
        value.map((item) => this.normalizeStringValue(item)).filter(Boolean),
      ),
    );
  }

  private normalizeStringValue(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number') return String(value);
    return '';
  }

  private asObjectRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    return value as Record<string, unknown>;
  }

  private readMetaString(
    meta: Record<string, unknown> | null,
    key: string,
  ): string | undefined {
    if (!meta) return undefined;
    const value = meta[key];
    if (typeof value === 'string') {
      const normalized = value.trim();
      return normalized.length ? normalized : undefined;
    }
    if (typeof value === 'number') {
      const normalized = String(value).trim();
      return normalized.length ? normalized : undefined;
    }
    return undefined;
  }

  private readMetaBoolean(
    meta: Record<string, unknown> | null,
    key: string,
  ): boolean | undefined {
    if (!meta) return undefined;
    const value = meta[key];
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'false' || normalized === '0' || normalized === 'no') {
        return false;
      }
    }
    return undefined;
  }

  private parseTrackingCodeFromMeta(
    meta: Record<string, unknown> | null,
  ): string | undefined {
    return (
      this.readMetaString(meta, 'tracking_code') ||
      this.readMetaString(meta, 'pr_code') ||
      this.readMetaString(meta, 'ref_code') ||
      this.readMetaString(meta, 'promo_code')
    );
  }

  private roleHasDefaultPrComplimentary(role: unknown): boolean {
    const normalized = String(role ?? '')
      .trim()
      .toLowerCase();
    return normalized === 'responsabile' || normalized === 'pr';
  }

  private isReservationComplimentary(
    meta: unknown,
    totalAmount?: Prisma.Decimal | number | string | null,
  ): boolean {
    const record = this.asObjectRecord(meta);
    const fromFlags =
      this.readMetaBoolean(record, 'pr_omaggio_default') ||
      this.readMetaBoolean(record, 'entry_omaggio') ||
      this.readMetaBoolean(record, 'is_complimentary') ||
      false;

    if (fromFlags) return true;
    if (totalAmount === null || totalAmount === undefined) return false;
    const amount = Number(totalAmount);
    return Number.isFinite(amount) && amount <= 0;
  }

  private ageBucketFromBirthDate(
    birthDate?: Date | null,
    at: Date = new Date(),
  ): AgeBucket | null {
    if (!birthDate) return null;

    let age = at.getFullYear() - birthDate.getFullYear();
    const monthDiff = at.getMonth() - birthDate.getMonth();
    const dayDiff = at.getDate() - birthDate.getDate();
    if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
      age -= 1;
    }

    if (!Number.isFinite(age) || age < 0) return null;
    if (age <= 20) return AgeBucket.AGE_18_20;
    if (age <= 24) return AgeBucket.AGE_21_24;
    if (age <= 29) return AgeBucket.AGE_25_29;
    if (age <= 34) return AgeBucket.AGE_30_34;
    return AgeBucket.AGE_35_PLUS;
  }

  private mergeReferralMeta(
    baseMeta: Record<string, unknown> | null,
    referral: ReservationReferralMeta,
  ): Prisma.InputJsonValue | undefined {
    const merged: Record<string, unknown> = {
      ...(baseMeta ?? {}),
    };

    if (referral.inviter_user_id) {
      merged.inviter_user_id = referral.inviter_user_id;
    }

    if (referral.tracking_code) {
      merged.tracking_code = referral.tracking_code;
      merged.pr_code = referral.pr_code ?? referral.tracking_code;
      merged.ref_code = referral.ref_code ?? referral.tracking_code;
      merged.promo_code = referral.promo_code ?? referral.tracking_code;
    }

    if (referral.pr_membership_id) {
      merged.pr_membership_id = referral.pr_membership_id;
    }

    if (referral.pr_role) {
      merged.pr_role = referral.pr_role;
    }

    if (referral.pr_omaggio_default !== undefined) {
      merged.pr_omaggio_default = referral.pr_omaggio_default;
      merged.entry_omaggio = referral.pr_omaggio_default;
      merged.is_complimentary = referral.pr_omaggio_default;
    }

    if (referral.wallet_pass_eligible !== undefined) {
      merged.wallet_pass_eligible = referral.wallet_pass_eligible;
    }

    if (!Object.keys(merged).length) return undefined;
    return merged as Prisma.InputJsonValue;
  }

  /**
   * Resolves an incoming ref_code/pr_code/inviter_user_id (from `meta`) against an active
   * `venue_pr_memberships` row for this event's venue, and builds the referral fields to
   * persist on the reservation. Shared by the authenticated createReservation() path and
   * the unauthenticated guestJoinEntry() path - an unmatched/expired/wrong-venue code is
   * silently dropped in both, never persisted verbatim.
   */
  private async resolveReferralAttribution(params: {
    venueId: string | null | undefined;
    meta: Record<string, unknown> | null;
    type: 'table' | 'entry';
  }): Promise<{
    referralMeta: ReservationReferralMeta | null;
    prMembership: {
      id: string;
      user_id: string;
      role: string;
      ref_code: string;
    } | null;
    isPrComplimentaryEntry: boolean;
  }> {
    const referralCode = this.parseTrackingCodeFromMeta(params.meta);
    const invitedByUserId = this.readMetaString(params.meta, 'inviter_user_id');
    const prMembershipOrFilters: Prisma.venue_pr_membershipsWhereInput[] = [
      ...(referralCode
        ? [{ ref_code: { equals: referralCode, mode: 'insensitive' as const } }]
        : []),
      ...(invitedByUserId ? [{ user_id: invitedByUserId }] : []),
    ];

    const prMembership =
      (referralCode || invitedByUserId) && params.venueId
        ? await this.prisma.venue_pr_memberships.findFirst({
            where: {
              venue_id: params.venueId,
              is_active: true,
              OR: prMembershipOrFilters,
            },
            select: {
              id: true,
              user_id: true,
              role: true,
              ref_code: true,
            },
          })
        : null;

    const isPrComplimentaryEntry =
      params.type === 'entry' &&
      Boolean(
        prMembership && this.roleHasDefaultPrComplimentary(prMembership.role),
      );

    // Only persist referral/tracking fields once they resolve to a real, active PR
    // membership for this venue. An unmatched ref_code (typo, wrong venue, revoked
    // membership) must not be written verbatim into reservations.meta.
    const referralMeta: ReservationReferralMeta | null = prMembership
      ? {
          inviter_user_id: prMembership.user_id,
          tracking_code: prMembership.ref_code,
          pr_code: prMembership.ref_code,
          ref_code: prMembership.ref_code,
          promo_code: prMembership.ref_code,
          pr_membership_id: prMembership.id,
          pr_role: prMembership.role,
          pr_omaggio_default: isPrComplimentaryEntry,
          wallet_pass_eligible: isPrComplimentaryEntry,
        }
      : null;

    return { referralMeta, prMembership, isPrComplimentaryEntry };
  }

  private getErrorDetails(error: unknown): { code?: string; message: string } {
    if (error && typeof error === 'object') {
      const maybeError = error as { code?: unknown; message?: unknown };
      return {
        code: typeof maybeError.code === 'string' ? maybeError.code : undefined,
        message:
          typeof maybeError.message === 'string' ? maybeError.message : '',
      };
    }

    return { code: undefined, message: '' };
  }

  private parseTableReservationMeta(
    meta: unknown,
  ): TableReservationMeta | null {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;

    const raw = meta as Record<string, unknown>;
    const invitedFriendIds = this.normalizeStringArray(raw.invited_friend_ids);
    const invitedGroupIds = this.normalizeStringArray(
      raw.invited_group_ids ?? raw.invited_groups,
    );
    const tableInvitesRaw = Array.isArray(raw.table_invites)
      ? raw.table_invites
      : [];

    const tableInvites = tableInvitesRaw
      .map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          return null;
        }
        const row = item as Record<string, unknown>;
        const userId = this.normalizeStringValue(row.user_id);
        if (!userId) return null;
        const statusValue = this.normalizeStringValue(
          row.status ?? 'pending',
        ).toLowerCase();
        const status: TableInvitationStatus =
          statusValue === 'accepted' || statusValue === 'declined'
            ? (statusValue as TableInvitationStatus)
            : 'pending';
        const sourceValue = this.normalizeStringValue(
          row.source ?? 'direct',
        ).toLowerCase();
        const source = sourceValue === 'group' ? 'group' : 'direct';
        return {
          user_id: userId,
          status,
          source,
          invited_group_ids: this.normalizeStringArray(row.invited_group_ids),
          responded_at:
            row.responded_at === null || row.responded_at === undefined
              ? null
              : this.normalizeStringValue(row.responded_at),
        } satisfies TableInviteMetaItem;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);

    if (
      !invitedFriendIds.length &&
      !invitedGroupIds.length &&
      !tableInvites.length &&
      !raw.booking_mode &&
      !raw.zone_label &&
      !raw.zona
    ) {
      return null;
    }

    return {
      booking_mode:
        typeof raw.booking_mode === 'string' ? raw.booking_mode : undefined,
      zone_label:
        typeof raw.zone_label === 'string'
          ? raw.zone_label
          : typeof raw.zona === 'string'
            ? raw.zona
            : undefined,
      invited_friend_ids: invitedFriendIds,
      invited_group_ids: invitedGroupIds,
      inviter_user_id: this.normalizeStringValue(raw.inviter_user_id),
      inviter_name:
        typeof raw.inviter_name === 'string' ? raw.inviter_name : undefined,
      table_invites: tableInvites,
    };
  }

  private resolveZoneLabel(reservation: {
    venue_table_zone?: { name?: string | null } | null;
    meta?: unknown;
  }) {
    const zoneName = String(reservation.venue_table_zone?.name ?? '').trim();
    if (zoneName) return zoneName;
    return this.parseTableReservationMeta(reservation.meta)?.zone_label ?? null;
  }

  private async buildTableReservationMeta(
    metaInput: unknown,
    inviterId: string,
  ) {
    if (
      !metaInput ||
      typeof metaInput !== 'object' ||
      Array.isArray(metaInput)
    ) {
      return undefined;
    }

    const rawMeta = metaInput as Record<string, unknown>;
    const requestedFriendIds = this.normalizeStringArray(
      rawMeta.invited_friend_ids,
    );
    const requestedGroupIds = this.normalizeStringArray(rawMeta.invited_groups);

    const [inviter, directFriendships, groups] = await Promise.all([
      this.prisma.users.findUnique({
        where: { id: inviterId },
        select: { name: true, username: true },
      }),
      requestedFriendIds.length
        ? this.prisma.friendships.findMany({
            where: {
              user_id: inviterId,
              friend_id: { in: requestedFriendIds },
            },
            select: { friend_id: true },
          })
        : Promise.resolve<Array<{ friend_id: string }>>([]),
      requestedGroupIds.length
        ? this.prisma.friend_groups.findMany({
            where: {
              id: { in: requestedGroupIds },
              OR: [
                { owner_id: inviterId },
                { members: { some: { user_id: inviterId } } },
              ],
            },
            select: {
              id: true,
              members: { select: { user_id: true } },
            },
          })
        : Promise.resolve<
            Array<{ id: string; members: Array<{ user_id: string }> }>
          >([]),
    ]);

    const validDirectFriendIds = directFriendships.map((row) => row.friend_id);
    const userToGroups = new Map<string, string[]>();

    for (const group of groups) {
      for (const member of group.members) {
        if (!member.user_id || member.user_id === inviterId) continue;
        const next = userToGroups.get(member.user_id) ?? [];
        next.push(group.id);
        userToGroups.set(member.user_id, next);
      }
    }

    const invitedFriendIds = Array.from(
      new Set([...validDirectFriendIds, ...Array.from(userToGroups.keys())]),
    ).filter((id): id is string => Boolean(id) && id !== inviterId);

    const tableInvites: TableInviteMetaItem[] = invitedFriendIds.map(
      (userId) => ({
        user_id: userId,
        status: 'pending',
        source: userToGroups.has(userId) ? 'group' : 'direct',
        invited_group_ids: userToGroups.get(userId) ?? [],
        responded_at: null,
      }),
    );

    const bookingMode =
      typeof rawMeta.booking_mode === 'string' && rawMeta.booking_mode.trim()
        ? rawMeta.booking_mode.trim()
        : undefined;
    const zoneLabel =
      typeof rawMeta.zona === 'string' && rawMeta.zona.trim()
        ? rawMeta.zona.trim()
        : typeof rawMeta.zone_label === 'string' && rawMeta.zone_label.trim()
          ? rawMeta.zone_label.trim()
          : undefined;

    if (!bookingMode && !zoneLabel && tableInvites.length === 0) {
      return undefined;
    }

    return {
      ...(bookingMode ? { booking_mode: bookingMode } : {}),
      ...(zoneLabel ? { zone_label: zoneLabel } : {}),
      invited_friend_ids: invitedFriendIds,
      invited_group_ids: groups.map((group) => group.id),
      inviter_user_id: inviterId,
      inviter_name: inviter?.name || inviter?.username || 'Un amico',
      table_invites: tableInvites,
    } as Prisma.InputJsonValue;
  }

  async resolveVenueIdForUser(userId: string): Promise<string | null> {
    const u = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { venue_id: true },
    });
    return u?.venue_id ?? null;
  }

  async assertEventBelongsToVenue(eventId: string, venueId: string) {
    const event = await this.prisma.events.findFirst({
      where: { id: eventId, venue_id: venueId },
      select: { id: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found for this venue');
    }
  }

  async listBookedZoneIdsForEvent(eventId: string): Promise<string[]> {
    const rows = await this.prisma.reservations.findMany({
      where: {
        event_id: eventId,
        type: 'table',
        status: { not: 'cancelled' },
        venue_table_zone_id: { not: null },
      },
      select: { venue_table_zone_id: true },
    });

    return Array.from(
      new Set(
        rows
          .map((row) => row.venue_table_zone_id)
          .filter((id): id is string => Boolean(id)),
      ),
    );
  }

  private reservationSelect() {
    return {
      id: true,
      user_id: true,
      event_id: true,
      venue_table_zone_id: true,
      table_name: true,
      meta: true,
      type: true,
      status: true,
      guests: true,
      actual_guests: true,
      total_amount: true,
      qr_token: true,
      qr_payload: true,
      guest_token: true,
      checked_in_at: true,
      checked_in_by_staff_id: true,
      checkin_entry_id: true,
      created_at: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
        },
      },
      event: {
        select: {
          id: true,
          venue_id: true,
          name: true,
          date: true,
          start_time: true,
          end_time: true,
          venue: {
            select: {
              id: true,
              name: true,
              city: true,
              address: true,
              latitude: true,
              longitude: true,
              image: true,
            },
          },
        },
      },
      venue_table_zone: {
        select: {
          id: true,
          venue_id: true,
          name: true,
          per_testa: true,
          costo_minimo: true,
          persone_max: true,
          booking_policy: true,
        },
      },
    } satisfies Prisma.reservationsSelect;
  }

  private buildEntryQrPayload(params: {
    reservationId: string;
    userId: string | null;
    eventId: string;
    qrToken: string;
  }) {
    return {
      v: 1,
      type: 'event_entry',
      reservation_id: params.reservationId,
      user_id: params.userId,
      event_id: params.eventId,
      qr_token: params.qrToken,
      issued_at: new Date().toISOString(),
    };
  }

  private parseQrData(raw: string): ParsedQrData {
    const value = String(raw ?? '').trim();
    if (!value) return {};

    if (value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        return {
          passType:
            (typeof parsed.type === 'string' && parsed.type) ||
            (typeof parsed.pass_type === 'string' && parsed.pass_type) ||
            undefined,
          passId:
            (typeof parsed.pass_id === 'string' && parsed.pass_id) ||
            (typeof parsed.passId === 'string' && parsed.passId) ||
            undefined,
          qrToken:
            (typeof parsed.qr_token === 'string' && parsed.qr_token) ||
            (typeof parsed.qrToken === 'string' && parsed.qrToken) ||
            (typeof parsed.token === 'string' && parsed.token) ||
            undefined,
          reservationId:
            (typeof parsed.reservation_id === 'string' &&
              parsed.reservation_id) ||
            (typeof parsed.reservationId === 'string' &&
              parsed.reservationId) ||
            undefined,
          userId:
            (typeof parsed.user_id === 'string' && parsed.user_id) ||
            (typeof parsed.userId === 'string' && parsed.userId) ||
            undefined,
          eventId:
            (typeof parsed.event_id === 'string' && parsed.event_id) ||
            (typeof parsed.eventId === 'string' && parsed.eventId) ||
            undefined,
          passVenueId:
            (typeof parsed.venue_id === 'string' && parsed.venue_id) ||
            (typeof parsed.venueId === 'string' && parsed.venueId) ||
            undefined,
          passMembershipId:
            (typeof parsed.pr_membership_id === 'string' &&
              parsed.pr_membership_id) ||
            (typeof parsed.prMembershipId === 'string' &&
              parsed.prMembershipId) ||
            undefined,
        };
      } catch {
        return {};
      }
    }

    // A raw (non-JSON) scanned value is only ever treated as a candidate qr_token, a real
    // secret unique per reservation. It must never double as a user_id lookup key - that
    // would let anyone check a person in by merely knowing/guessing their user id, with no
    // possession of their actual QR pass required.
    return { qrToken: value };
  }

  private normalizeCreateReservationDto(
    dto: Record<string, unknown> | null | undefined,
  ): {
    user_id?: string;
    event_id?: string;
    type?: 'table' | 'entry';
    guests?: unknown;
    venue_table_zone_id?: string | null;
    table_name?: unknown;
    meta?: unknown;
    total_amount?: unknown;
  } {
    const payload = dto ?? {};
    const user_id =
      this.normalizeStringValue(payload.user_id ?? payload.userId) || undefined;
    const event_id =
      this.normalizeStringValue(payload.event_id ?? payload.eventId) ||
      undefined;
    const type =
      payload.type === 'table' || payload.type === 'entry'
        ? payload.type
        : undefined;
    const guests =
      payload.guests ??
      payload.guests_count ??
      payload.guestsCount ??
      payload.seats ??
      payload.people;
    const venue_table_zone_id =
      this.normalizeStringValue(
        payload.venue_zone_id ??
          payload.venueZoneId ??
          payload.venue_table_zone_id ??
          payload.venueTableZoneId,
      ) || null;
    const total_amount = payload.total_amount ?? payload.totalAmount;
    const table_name = payload.table_name ?? payload.tableName;
    const meta = this.mergeRootReferralIntoMeta(payload);

    return {
      user_id,
      event_id,
      type,
      guests,
      venue_table_zone_id,
      table_name,
      meta,
      total_amount,
    };
  }

  /**
   * Referral tracking (ref_code/pr_code/tracking_code/promo_code/inviter_user_id) is read
   * exclusively from `meta` downstream (see parseTrackingCodeFromMeta). Some frontend call
   * sites send these fields at the payload root instead of nested in `meta`, which silently
   * drops PR attribution with no error. Absorb root-level referral fields into `meta` here so
   * attribution works regardless of where the client places them, without already-nested
   * meta fields being overridden.
   */
  private mergeRootReferralIntoMeta(payload: Record<string, unknown>): unknown {
    const rootReferralKeys = [
      'ref_code',
      'pr_code',
      'tracking_code',
      'promo_code',
      'inviter_user_id',
    ] as const;

    const existingMeta = this.asObjectRecord(payload.meta);
    const additions: Record<string, unknown> = {};

    for (const key of rootReferralKeys) {
      if (existingMeta && existingMeta[key] !== undefined) continue;
      const rootValue = this.normalizeStringValue(payload[key]);
      if (rootValue) additions[key] = rootValue;
    }

    if (!Object.keys(additions).length) return payload.meta;

    return { ...(existingMeta ?? {}), ...additions };
  }

  private normalizeTableName(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new BadRequestException('table_name must be a string');
    }
    const tableName = String(value).trim();
    if (!tableName.length) return null;
    if (tableName.length > 60) {
      throw new BadRequestException('table_name must be <= 60 chars');
    }
    return tableName;
  }

  private normalizeGuests(value: unknown): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) {
      throw new BadRequestException('guests must be an integer >= 1');
    }
    return n;
  }

  private unwrapSetField(value: unknown): unknown {
    if (
      value &&
      typeof value === 'object' &&
      'set' in (value as Record<string, unknown>)
    ) {
      return (value as Record<string, unknown>).set;
    }
    return value;
  }

  private parseGuestsUpdateValue(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    return this.normalizeGuests(this.unwrapSetField(value));
  }

  private parseTotalAmountUpdateValue(
    value: unknown,
  ): number | null | undefined {
    if (value === undefined) return undefined;
    const raw = this.unwrapSetField(value);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      throw new BadRequestException('total_amount must be a number >= 0');
    }
    return n;
  }

  private normalizeReservationStatusUpdate(
    value: unknown,
  ): 'pending' | 'confirmed' | 'cancelled' | 'completed' | undefined {
    if (value === undefined) return undefined;
    const raw = this.unwrapSetField(value);
    if (raw === undefined) return undefined;

    if (typeof raw !== 'string') {
      throw new BadRequestException(
        'status must be pending|confirmed|cancelled|completed',
      );
    }

    const status = raw.trim().toLowerCase();
    if (
      status === 'pending' ||
      status === 'confirmed' ||
      status === 'cancelled' ||
      status === 'completed'
    ) {
      return status;
    }

    throw new BadRequestException(
      'status must be pending|confirmed|cancelled|completed',
    );
  }

  // `cancelled` and `completed` are terminal - allowing a PATCH to move a reservation back
  // out of either (e.g. `cancelled` -> `confirmed`) risks reviving a booking whose table/
  // slot may already be re-sold to someone else (the partial-unique booking index only
  // excludes `status <> 'cancelled'` rows, so an "un-cancel" can collide with a newer
  // booking instead of being rejected cleanly up front). checkinTableReservation already
  // enforces this for its own transition; this centralizes the same rule for the generic
  // PATCH path.
  private static readonly RESERVATION_STATUS_TRANSITIONS: Record<
    'pending' | 'confirmed' | 'cancelled' | 'completed',
    ReadonlyArray<'pending' | 'confirmed' | 'cancelled' | 'completed'>
  > = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['completed', 'cancelled'],
    cancelled: [],
    completed: [],
  };

  private assertValidReservationStatusTransition(
    from: 'pending' | 'confirmed' | 'cancelled' | 'completed',
    to: 'pending' | 'confirmed' | 'cancelled' | 'completed',
  ) {
    if (from === to) return;
    const allowed =
      ReservationsService.RESERVATION_STATUS_TRANSITIONS[from] ?? [];
    if (!allowed.includes(to)) {
      throw new BadRequestException(
        `Impossibile passare una prenotazione da "${from}" a "${to}".`,
      );
    }
  }

  private isActiveTableReservationStatus(status: string | null | undefined) {
    return (
      String(status ?? '')
        .trim()
        .toLowerCase() !== 'cancelled'
    );
  }

  // Repricing helper for guests changing on an already-booked zone (the zone itself can no
  // longer be reassigned via update - see updateReservation - only guests/total_amount can
  // change on an existing table reservation).
  private async computeZoneTotalAmount(params: {
    eventId: string;
    venueTableZoneId: string;
    guests: number;
  }): Promise<Prisma.Decimal | null> {
    const [zone, eventZoneRow] = await Promise.all([
      this.prisma.venue_table_zones.findUnique({
        where: { id: params.venueTableZoneId },
        select: {
          id: true,
          venue_id: true,
          per_testa: true,
          costo_minimo: true,
          persone_max: true,
        },
      }),
      this.prisma.event_tables.findFirst({
        where: {
          event_id: params.eventId,
          venue_table_zone_id: params.venueTableZoneId,
        },
        select: {
          per_testa_override: true,
          costo_minimo_override: true,
          persone_max_override: true,
        },
      }),
    ]);

    if (!zone) throw new NotFoundException('Zone not found');

    const eventOverridePerTesta: unknown = eventZoneRow?.per_testa_override;
    const eventOverrideCostoMinimo: unknown =
      eventZoneRow?.costo_minimo_override;
    const eventOverridePersoneMax: unknown = eventZoneRow?.persone_max_override;

    const effectivePerTesta: Prisma.Decimal | null =
      eventOverridePerTesta === null || eventOverridePerTesta === undefined
        ? (zone.per_testa ?? null)
        : (eventOverridePerTesta as Prisma.Decimal);
    const effectiveCostoMinimo: Prisma.Decimal | null =
      eventOverrideCostoMinimo === null ||
      eventOverrideCostoMinimo === undefined
        ? (zone.costo_minimo ?? null)
        : (eventOverrideCostoMinimo as Prisma.Decimal);
    const effectivePersoneMax: number | null =
      eventOverridePersoneMax === null || eventOverridePersoneMax === undefined
        ? (zone.persone_max ?? null)
        : Number(eventOverridePersoneMax);

    if (effectivePersoneMax && params.guests > effectivePersoneMax) {
      throw new BadRequestException('guests exceeds zone persone_max');
    }

    if (effectivePerTesta) {
      const computed = effectivePerTesta.mul(new Prisma.Decimal(params.guests));
      if (effectiveCostoMinimo) {
        return Prisma.Decimal.max(computed, effectiveCostoMinimo);
      }
      return computed;
    }

    if (effectiveCostoMinimo) {
      return effectiveCostoMinimo;
    }

    return null;
  }

  /** Scalar-only fields of `reservationSelect()` - no nested relations. */
  private reservationScalarSelect() {
    return {
      id: true,
      user_id: true,
      event_id: true,
      venue_table_zone_id: true,
      table_name: true,
      meta: true,
      type: true,
      status: true,
      guests: true,
      actual_guests: true,
      total_amount: true,
      qr_token: true,
      qr_payload: true,
      checked_in_at: true,
      checked_in_by_staff_id: true,
      checkin_entry_id: true,
      created_at: true,
    } satisfies Prisma.reservationsSelect;
  }

  /**
   * Attaches `user`/`event`(+venue)/`venue_table_zone` to a batch of scalar reservation
   * rows via batched `findMany({ where: { id: { in: [...] } } })` lookups instead of Prisma
   * resolving them as nested joins per row. For a small row count this turns 1 query with
   * nested relations (measured ~600ms+ even for a handful of rows) into flat, independent
   * queries running concurrently (~1 query's worth of latency).
   */
  private async hydrateReservations<
    T extends {
      user_id: string | null;
      event_id: string;
      venue_table_zone_id: string | null;
    },
  >(rows: T[]) {
    const userIds = Array.from(
      new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id)),
    );
    const eventIds = Array.from(new Set(rows.map((r) => r.event_id)));
    const zoneIds = Array.from(
      new Set(
        rows
          .map((r) => r.venue_table_zone_id)
          .filter((id): id is string => !!id),
      ),
    );

    // `{ in: [] }` is a well-defined empty-result Prisma query (not an error), so these
    // always run rather than being conditionally skipped - simpler and just as cheap when a
    // batch happens to have no rows of that kind.
    const [users, events, zones] = await Promise.all([
      this.prisma.users.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true, phone: true },
      }),
      this.prisma.events.findMany({
        where: { id: { in: eventIds } },
        select: {
          id: true,
          venue_id: true,
          name: true,
          date: true,
          start_time: true,
          end_time: true,
          venue: {
            select: {
              id: true,
              name: true,
              city: true,
              address: true,
              latitude: true,
              longitude: true,
              image: true,
            },
          },
        },
      }),
      this.prisma.venue_table_zones.findMany({
        where: { id: { in: zoneIds } },
        select: {
          id: true,
          venue_id: true,
          name: true,
          per_testa: true,
          costo_minimo: true,
          persone_max: true,
          booking_policy: true,
        },
      }),
    ]);

    const userById = new Map(users.map((u) => [u.id, u]));
    const eventById = new Map(events.map((e) => [e.id, e]));
    const zoneById = new Map(zones.map((z) => [z.id, z]));

    return rows.map((row) => ({
      ...row,
      user: row.user_id ? (userById.get(row.user_id) ?? null) : null,
      event: eventById.get(row.event_id) ?? null,
      venue_table_zone: row.venue_table_zone_id
        ? (zoneById.get(row.venue_table_zone_id) ?? null)
        : null,
    }));
  }

  async listReservations(params?: {
    eventId?: string;
    userId?: string;
    venueId?: string;
    date?: string;
  }) {
    const where: Prisma.reservationsWhereInput = {};
    if (params?.eventId) where.event_id = params.eventId;
    if (params?.userId) where.user_id = params.userId;
    if (params?.venueId) where.event = { venue_id: params.venueId };
    // date filtering not supported by current schema (no date column)
    const rows = await this.prisma.reservations.findMany({
      where,
      orderBy: { created_at: 'desc' },
      // Safety-net cap: unfiltered admin queries (no event_id/user_id) would otherwise scan
      // every reservation ever made. Callers needing more should use the paginated variant.
      take: 1000,
      select: this.reservationScalarSelect(),
    });
    return this.hydrateReservations(rows);
  }

  async listReservationsPaginated(
    page: number,
    pageSize: number,
    params?: { eventId?: string; userId?: string; venueId?: string },
  ) {
    const take = Math.max(pageSize, 1);
    const skip = (Math.max(page, 1) - 1) * take;

    const where: Prisma.reservationsWhereInput = {};
    if (params?.eventId) where.event_id = params.eventId;
    if (params?.userId) where.user_id = params.userId;
    if (params?.venueId) where.event = { venue_id: params.venueId };

    const [total, data] = await this.prisma.$transaction([
      this.prisma.reservations.count({ where }),
      this.prisma.reservations.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take,
        select: this.reservationSelect(),
      }),
    ]);

    return {
      data,
      total,
      page: Math.max(page, 1),
      pageSize: take,
      hasMore: skip + data.length < total,
    };
  }

  async getReservation(id: string) {
    const r = await this.prisma.reservations.findUnique({
      where: { id },
      select: this.reservationSelect(),
    });
    if (!r) throw new NotFoundException('Reservation not found');
    return r;
  }

  async createReservation(dto: Record<string, unknown> | null | undefined) {
    const normalized = this.normalizeCreateReservationDto(dto);

    const userId: string | undefined = normalized.user_id;
    const eventId: string | undefined = normalized.event_id;
    const type: 'table' | 'entry' | undefined = normalized.type;

    if (!userId) throw new BadRequestException('user_id required');
    if (!eventId) throw new BadRequestException('event_id required');
    if (type !== 'table' && type !== 'entry') {
      throw new BadRequestException('type must be "table" or "entry"');
    }

    const guests = this.normalizeGuests(normalized.guests);

    const [event, userRecord] = await Promise.all([
      this.prisma.events.findUnique({
        where: { id: eventId },
        select: { id: true, venue_id: true, name: true },
      }),
      // ❗ Saltiamo il controllo duplicati se è un account venue
      this.prisma.users.findUnique({
        where: { id: userId },
        select: { role: true },
      }),
    ]);
    if (!event) throw new NotFoundException('Event not found');

    if (userRecord?.role !== 'venue') {
      const existingReservationForEvent =
        await this.prisma.reservations.findFirst({
          where: {
            user_id: userId,
            event_id: eventId,
            type,
            status: { in: ['pending', 'confirmed', 'completed'] },
          },
          select: { id: true },
        });

      if (existingReservationForEvent) {
        throw new BadRequestException(
          type === 'table'
            ? 'Hai già un tavolo prenotato per questa serata'
            : 'Sei già in lista per questa serata',
        );
      }
    }

    const incomingMeta = this.asObjectRecord(normalized.meta);
    const { referralMeta, prMembership, isPrComplimentaryEntry } =
      await this.resolveReferralAttribution({
        venueId: event.venue_id,
        meta: incomingMeta,
        type,
      });

    const venueTableZoneId: string | null | undefined =
      normalized.venue_table_zone_id ?? null;
    const tableName = this.normalizeTableName(normalized.table_name);
    const tableReservationMeta =
      type === 'table'
        ? await this.buildTableReservationMeta(normalized.meta, userId)
        : undefined;
    const reservationMeta = this.mergeReferralMeta(
      this.asObjectRecord(tableReservationMeta ?? incomingMeta),
      referralMeta ?? {},
    );

    let totalAmount: Prisma.Decimal | undefined;
    if (
      normalized?.total_amount !== null &&
      normalized?.total_amount !== undefined
    ) {
      const n = Number(normalized.total_amount);
      if (!Number.isFinite(n) || n < 0) {
        throw new BadRequestException('total_amount must be a number >= 0');
      }
      totalAmount = new Prisma.Decimal(n);
    }

    if (isPrComplimentaryEntry && type === 'entry') {
      totalAmount = new Prisma.Decimal(0);
    }

    if (type === 'table') {
      if (!venueTableZoneId) {
        throw new BadRequestException(
          'venue_zone_id required for table reservations',
        );
      }

      const zone = await this.prisma.venue_table_zones.findUnique({
        where: { id: venueTableZoneId },
        select: {
          id: true,
          venue_id: true,
          per_testa: true,
          costo_minimo: true,
          persone_max: true,
          is_active: true,
        },
      });
      if (!zone) throw new NotFoundException('Zone not found');
      if (!zone.is_active) throw new BadRequestException('Zone is not active');
      if (zone.venue_id !== event.venue_id) {
        throw new BadRequestException(
          'Selected zone does not belong to this event venue',
        );
      }

      const effectivePerTesta = zone.per_testa ?? null;
      const effectiveCostoMinimo = zone.costo_minimo ?? null;
      const effectivePersoneMax = zone.persone_max ?? null;

      if (effectivePersoneMax && guests > effectivePersoneMax) {
        throw new BadRequestException('guests exceeds table persone_max');
      }

      // Auto compute total_amount if missing and per_testa is available
      if (!totalAmount && effectivePerTesta) {
        try {
          const computed = effectivePerTesta.mul(new Prisma.Decimal(guests));
          if (effectiveCostoMinimo) {
            totalAmount = Prisma.Decimal.max(computed, effectiveCostoMinimo);
          } else {
            totalAmount = computed;
          }
        } catch {
          // ignore
        }
      } else if (!totalAmount && effectiveCostoMinimo) {
        totalAmount = effectiveCostoMinimo;
      }
    }

    // Entry (lista) reservations don't require venue approval, so they're confirmed
    // immediately; the venue confirms table reservations explicitly before they occupy
    // the zone. Neither can be set by the caller - see checkinTableReservation() for how
    // a table reservation later becomes `completed`, and scanEntryQr() for entries.
    const status: 'pending' | 'confirmed' =
      type === 'entry' ? 'confirmed' : 'pending';

    const qrToken = type === 'entry' ? randomUUID() : undefined;

    const createdReservation = await (async () => {
      try {
        return await this.prisma.reservations.create({
          data: {
            user_id: userId,
            event_id: eventId,
            venue_table_zone_id: type === 'table' ? venueTableZoneId : null,
            table_name: type === 'table' ? tableName : null,
            meta: reservationMeta,
            type,
            status,
            guests,
            total_amount: totalAmount,
            qr_token: qrToken,
          },
          select: this.reservationSelect(),
        });
      } catch (error: unknown) {
        const { code: prismaCode, message } = this.getErrorDetails(error);
        const errorMessage = message.toLowerCase();
        if (
          prismaCode === 'P2002' ||
          errorMessage.includes(
            'reservations_unique_active_user_event_type_idx',
          ) ||
          errorMessage.includes(
            'duplicate key value violates unique constraint',
          )
        ) {
          throw new BadRequestException(
            type === 'table'
              ? 'Hai già un tavolo prenotato per questa serata'
              : 'Sei già in lista per questa serata',
          );
        }
        throw error;
      }
    })();

    const createdId = createdReservation.id;
    let finalReservation = createdReservation;

    this.evaluateBadges(userId);

    void this.notifyNewReservationInterestedParties({
      reservationId: createdId,
      type,
      eventName: event.name,
      venueId: event.venue_id,
      prMembershipUserId: prMembership?.user_id,
    }).catch((error) => {
      this.logger.error(
        `Failed to notify PR/venue for reservation ${createdId}`,
        error instanceof Error ? error.stack : undefined,
      );
    });

    if (type === 'table') {
      const createdWithMeta = await this.getReservation(createdId);

      void this.notifyInvitedFriendsOfNewTableReservation(
        createdWithMeta,
      ).catch((error) => {
        this.logger.error(
          `Failed to notify invited friends for reservation ${createdId}`,
          error instanceof Error ? error.stack : undefined,
        );
      });

      finalReservation = createdWithMeta;
    }

    if (type !== 'entry' || !qrToken) return finalReservation;

    const qrPayload = JSON.stringify(
      this.buildEntryQrPayload({
        reservationId: createdId,
        userId,
        eventId,
        qrToken,
      }),
    );

    return this.prisma.reservations.update({
      where: { id: createdId },
      data: { qr_payload: qrPayload },
      select: this.reservationSelect(),
    });
  }

  private normalizeGuestNamePart(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 80) return null;
    return trimmed;
  }

  private normalizeGuestEmail(value: unknown): string | null {
    const raw = this.normalizeStringValue(value);
    if (!raw) return null;
    const normalized = raw.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      throw new BadRequestException('email is not valid');
    }
    return normalized;
  }

  /**
   * Email/username lookup for the unauthenticated guest-join flow. This deliberately never
   * verifies a password or issues a session - a match only decides whose account the
   * resulting attendance is attributed to, per the confirmed "guest join is not a login"
   * rule (see docs/spec referral guest-join). Returns only the id, never anything about the
   * matched account, so the caller can't learn anything about someone else's profile.
   */
  private async findUserForGuestJoin(
    normalizedEmail: string | null,
    username: string | null,
  ): Promise<{ id: string } | null> {
    if (normalizedEmail) {
      const byEmail = await this.prisma.users.findFirst({
        where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
        select: { id: true },
      });
      if (byEmail) return byEmail;
    }
    if (username) {
      const byUsername = await this.prisma.users.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
        select: { id: true },
      });
      if (byUsername) return byUsername;
    }
    return null;
  }

  /** Strips everything that isn't safe to hand back to an unauthenticated caller holding
   * only a guestToken - no matched account's email/phone, no other guest's info. */
  private toGuestSafeReservation(reservation: {
    id: string;
    event_id: string;
    type: string;
    status: string;
    guests: number;
    qr_payload: string | null;
    checked_in_at: Date | null;
    created_at: Date;
    event?: {
      id: string;
      name: string;
      date: Date;
      start_time: Date | null;
      end_time: Date | null;
      venue?: {
        id: string;
        name: string;
        city: string | null;
        address: string | null;
      } | null;
    } | null;
  }) {
    return {
      id: reservation.id,
      event_id: reservation.event_id,
      type: reservation.type,
      status: reservation.status,
      guests: reservation.guests,
      qr_payload: reservation.qr_payload,
      checked_in_at: reservation.checked_in_at,
      created_at: reservation.created_at,
      event: reservation.event
        ? {
            id: reservation.event.id,
            name: reservation.event.name,
            date: reservation.event.date,
            start_time: reservation.event.start_time,
            end_time: reservation.event.end_time,
            venue: reservation.event.venue
              ? {
                  id: reservation.event.venue.id,
                  name: reservation.event.venue.name,
                  city: reservation.event.venue.city,
                  address: reservation.event.venue.address,
                }
              : null,
          }
        : null,
    };
  }

  /**
   * Public, unauthenticated "Mettiti in lista" for a visitor arriving from a PR referral
   * link who isn't logged in (and shouldn't have to be). Tries to resolve an existing
   * NightHub account by email/username - if one matches, the attendance is attributed to
   * it (`user_id` set) without ever authenticating as that account; otherwise a guest-only
   * entry is created (`user_id: null`, guest_name/guest_surname/guest_email). Either way a
   * `guest_token` is issued so the unauthenticated browser can fetch this reservation back
   * later via getGuestReservation(). Dedup: one active entry per event per resolved
   * identity (matched user_id, or normalized guest email when no account matched).
   */
  async guestJoinEntry(dto: Record<string, unknown> | null | undefined) {
    const payload = dto ?? {};
    const eventId = this.normalizeStringValue(
      payload.event_id ?? payload.eventId,
    );
    if (!eventId) throw new BadRequestException('event_id required');

    // Nome/cognome sono richiesti solo se serve creare una entry guest vera e propria
    // (nessun account trovato per l'email/username forniti) - se l'email corrisponde a un
    // account esistente bastano quelli, senza chiedere altro (vedi il branch "matchedUser"
    // più sotto).
    const firstName = this.normalizeGuestNamePart(
      payload.guest_name ?? payload.first_name ?? payload.firstName,
    );
    const lastName = this.normalizeGuestNamePart(
      payload.guest_surname ?? payload.last_name ?? payload.lastName,
    );

    const usernameRaw =
      this.normalizeStringValue(payload.username ?? payload.guest_username) ||
      null;
    const normalizedEmail = this.normalizeGuestEmail(
      payload.email ?? payload.guest_email,
    );
    if (!normalizedEmail && !usernameRaw) {
      throw new BadRequestException('email or username required');
    }

    const event = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { id: true, venue_id: true, name: true, status: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.status === 'CANCELLED') {
      throw new BadRequestException('Questo evento è stato annullato');
    }

    const matchedUser = await this.findUserForGuestJoin(
      normalizedEmail,
      usernameRaw,
    );

    const existing = matchedUser
      ? await this.prisma.reservations.findFirst({
          where: {
            event_id: eventId,
            user_id: matchedUser.id,
            type: 'entry',
            status: { not: 'cancelled' },
          },
          select: this.reservationSelect(),
        })
      : normalizedEmail
        ? await this.prisma.reservations.findFirst({
            where: {
              event_id: eventId,
              user_id: null,
              guest_email: normalizedEmail,
              type: 'entry',
              status: { not: 'cancelled' },
            },
            select: this.reservationSelect(),
          })
        : null;

    if (existing) {
      return {
        reservation: this.toGuestSafeReservation(existing),
        already_joined: true,
        // Only handed back when the existing entry is itself guest-owned (no account
        // matched) - never for a reservation belonging to someone else's account, which
        // would let anyone "recover" another user's QR just by typing their email.
        guest_token: existing.user_id
          ? undefined
          : (existing.guest_token ?? undefined),
      };
    }

    // No account matched and no pre-existing reservation to recover: a real guest entry
    // needs a name to be useful at the door. Machine-readable message on purpose (not
    // human copy) so the frontend can catch it and switch to asking for the name, instead
    // of showing a generic error - see GuestJoinSheet.
    if (!matchedUser && (!firstName || !lastName)) {
      throw new BadRequestException('guest_name_required');
    }

    const incomingMeta = this.asObjectRecord(
      this.mergeRootReferralIntoMeta(payload),
    );
    const { referralMeta, prMembership } =
      await this.resolveReferralAttribution({
        venueId: event.venue_id,
        meta: incomingMeta,
        type: 'entry',
      });
    const reservationMeta = this.mergeReferralMeta({}, referralMeta ?? {});

    const qrToken = randomUUID();
    const guestToken = randomUUID();

    const created = await (async () => {
      try {
        return await this.prisma.reservations.create({
          data: {
            user_id: matchedUser?.id ?? null,
            event_id: eventId,
            type: 'entry',
            status: 'confirmed',
            guests: 1,
            meta: reservationMeta,
            qr_token: qrToken,
            guest_name: matchedUser ? null : firstName,
            guest_surname: matchedUser ? null : lastName,
            guest_email: matchedUser ? null : normalizedEmail,
            guest_token: guestToken,
          },
          select: this.reservationSelect(),
        });
      } catch (error: unknown) {
        const { code, message } = this.getErrorDetails(error);
        if (
          code === 'P2002' ||
          message.toLowerCase().includes('duplicate key value')
        ) {
          throw new BadRequestException('Sei già in lista per questa serata');
        }
        throw error;
      }
    })();

    const qrPayload = JSON.stringify(
      this.buildEntryQrPayload({
        reservationId: created.id,
        userId: matchedUser?.id ?? null,
        eventId,
        qrToken,
      }),
    );
    const updated = await this.prisma.reservations.update({
      where: { id: created.id },
      data: { qr_payload: qrPayload },
      select: this.reservationSelect(),
    });

    this.evaluateBadges(matchedUser?.id ?? null);
    void this.notifyNewReservationInterestedParties({
      reservationId: created.id,
      type: 'entry',
      eventName: event.name,
      venueId: event.venue_id,
      prMembershipUserId: prMembership?.user_id,
    }).catch((error) => {
      this.logger.error(
        `Failed to notify PR/venue for guest reservation ${created.id}`,
        error instanceof Error ? error.stack : undefined,
      );
    });

    return {
      reservation: this.toGuestSafeReservation(updated),
      already_joined: false,
      guest_token: guestToken,
    };
  }

  /** Lets an unauthenticated browser that holds a guestToken (from guestJoinEntry) fetch
   * its own guest reservation back - e.g. to re-show the confirmation/QR after navigating
   * away and back. Never exposes anything beyond what toGuestSafeReservation allows. */
  async getGuestReservation(token: string) {
    const guestToken = this.normalizeStringValue(token);
    if (!guestToken) throw new BadRequestException('token required');

    const reservation = await this.prisma.reservations.findUnique({
      where: { guest_token: guestToken },
      select: this.reservationSelect(),
    });
    if (!reservation) throw new NotFoundException('Reservation not found');

    return this.toGuestSafeReservation(reservation);
  }

  async checkInEntryReservationByQr(params: {
    eventId: string;
    staffId: string;
    qrData: string;
    actualGuests?: number;
  }): Promise<QrCheckInResult> {
    const eventId = String(params.eventId ?? '').trim();
    const staffId = String(params.staffId ?? '').trim();
    const qrData = String(params.qrData ?? '').trim();

    if (!eventId) throw new BadRequestException('event_id required');
    if (!staffId) throw new BadRequestException('staff_id required');
    if (!qrData) throw new BadRequestException('qr_data required');

    const parsed = this.parseQrData(qrData);

    if (parsed.passType === 'pr_season_pass') {
      return this.checkInPrSeasonPassByQr({
        eventId,
        staffId,
        qrData,
        parsed,
      });
    }

    let reservation =
      (parsed.qrToken
        ? await this.prisma.reservations.findUnique({
            where: { qr_token: parsed.qrToken },
            include: {
              user: {
                select: { id: true, sesso: true, name: true, birth_date: true },
              },
              event: {
                select: { id: true, name: true, venue_id: true, date: true },
              },
            },
          })
        : null) ?? null;

    if (!reservation && parsed.reservationId) {
      reservation = await this.prisma.reservations.findUnique({
        where: { id: parsed.reservationId },
        include: {
          user: {
            select: { id: true, sesso: true, name: true, birth_date: true },
          },
          event: {
            select: { id: true, name: true, venue_id: true, date: true },
          },
        },
      });
    }

    if (!reservation) {
      throw new NotFoundException('Reservation not found for this QR');
    }

    if (reservation.type !== 'entry') {
      throw new BadRequestException('QR is not linked to an entry reservation');
    }

    if (reservation.event_id !== eventId) {
      throw new BadRequestException('QR does not belong to this event');
    }

    if (reservation.status === 'cancelled') {
      throw new BadRequestException('Reservation cancelled');
    }

    if (reservation.checked_in_at) {
      return {
        success: true,
        alreadyCheckedIn: true,
        reservation,
      };
    }

    const gender =
      reservation.user?.sesso === 'M'
        ? Gender.M
        : reservation.user?.sesso === 'F'
          ? Gender.F
          : Gender.ALTRO;

    const reservationIsComplimentary = this.isReservationComplimentary(
      reservation.meta,
      reservation.total_amount,
    );
    const ageBucket = this.ageBucketFromBirthDate(
      reservation.user?.birth_date ?? null,
      new Date(),
    );

    const entryPrice = await resolveEntryUnitPrice({
      prisma: this.prisma,
      eventId,
      gender,
      isComplimentary: reservationIsComplimentary,
    });

    // A list reservation books `guests` people under one QR; scanning it once must record
    // everyone who actually walked in, not just the one code that got scanned - otherwise
    // entries systematically undercounts group bookings and skews any show-up-rate derived
    // from it. Staff can override the count at the door (actualGuests); otherwise it
    // defaults to what was booked.
    const requestedGuests = Number.isFinite(params.actualGuests)
      ? Math.trunc(Number(params.actualGuests))
      : undefined;
    const guestsToCheckIn = Math.max(
      1,
      requestedGuests ?? reservation.guests ?? 1,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      // Atomically claims the check-in: `checked_in_at: null` in the WHERE is what makes
      // this a compare-and-swap instead of a plain write. Two near-simultaneous scans of
      // the same QR can both pass the pre-transaction guard above (it reads before either
      // has written), but only one of them can match this WHERE clause once the other has
      // already flipped `checked_in_at` - the loser gets `count: 0` and backs off instead
      // of creating a second batch of `entries` rows for the same reservation.
      const claim = await tx.reservations.updateMany({
        where: { id: reservation.id, checked_in_at: null },
        data: {
          status: 'completed',
          checked_in_at: new Date(),
          checked_in_by_staff_id: staffId,
          actual_guests: guestsToCheckIn,
        },
      });

      if (claim.count === 0) {
        return { alreadyCheckedIn: true as const };
      }

      const entryCreateData = {
        event_id: eventId,
        user_id: reservation.user_id,
        staff_id: staffId,
        sesso: gender,
        price: entryPrice,
        is_complimentary: reservationIsComplimentary,
        age_bucket: ageBucket,
        method: EntryMethod.QR,
      };
      const createdEntries: Array<
        Awaited<ReturnType<typeof tx.entries.create>>
      > = [];
      for (let i = 0; i < guestsToCheckIn; i += 1) {
        createdEntries.push(await tx.entries.create({ data: entryCreateData }));
      }
      const createdEntry = createdEntries[0];

      const updatedReservation = await tx.reservations.update({
        where: { id: reservation.id },
        data: { checkin_entry_id: createdEntry.id },
        include: {
          user: { select: { id: true, name: true, email: true, phone: true } },
          event: {
            select: {
              id: true,
              venue_id: true,
              name: true,
              date: true,
              start_time: true,
              end_time: true,
            },
          },
          venue_table_zone: true,
        },
      });

      return {
        alreadyCheckedIn: false as const,
        createdEntry,
        checkedInGuests: createdEntries.length,
        updatedReservation,
      };
    });

    if (result.alreadyCheckedIn) {
      return {
        success: true,
        alreadyCheckedIn: true,
        reservation,
      };
    }

    this.evaluateBadges(reservation.user_id);

    return {
      success: true,
      alreadyCheckedIn: false,
      reservation: result.updatedReservation,
      entry: result.createdEntry,
      checkedInGuests: result.checkedInGuests,
    };
  }

  private async checkInPrSeasonPassByQr(params: {
    eventId: string;
    staffId: string;
    qrData: string;
    parsed: ParsedQrData;
  }): Promise<QrCheckInResult> {
    const event = await this.prisma.events.findUnique({
      where: { id: params.eventId },
      select: { id: true, venue_id: true, date: true },
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // Only ever resolve the season pass by its qr_token, a real secret unique per pass. The
    // wallet QR payload always carries pass_id alongside qr_token (see
    // buildPrSeasonPassQrPayload), but pass_id alone must never be a valid check-in path -
    // it's a plain UUID a rogue actor could obtain (e.g. a team manager who can see a
    // teammate's pass row) without ever possessing that teammate's actual QR/token. Same
    // class of bug already fixed for the customer entry QR in parseQrData/
    // checkInEntryReservationByQr.
    const token = String(params.parsed.qrToken || '').trim();
    if (!token) {
      throw new BadRequestException('QR token required');
    }

    const passRows = await this.prisma.$queryRaw<
      PrSeasonPassLookupRow[]
    >(Prisma.sql`
      SELECT
        p.id,
        p.venue_id,
        p.pr_membership_id,
        p.user_id,
        p.status::text AS status,
        p.valid_from,
        p.valid_until,
        p.revoked_at,
        p.qr_token,
        m.is_active AS membership_is_active
      FROM venue_pr_membership_passes p
      JOIN venue_pr_memberships m ON m.id = p.pr_membership_id
      WHERE p.qr_token = ${token}
      LIMIT 1
    `);

    const pass = passRows[0] ?? null;
    if (!pass) {
      throw new NotFoundException('Season pass not found for this QR');
    }

    if (pass.venue_id !== event.venue_id) {
      throw new BadRequestException(
        'Season pass does not belong to this venue',
      );
    }

    if (!pass.membership_is_active) {
      throw new BadRequestException('Season pass membership is not active');
    }

    if (pass.status === 'revoked' || pass.revoked_at) {
      throw new BadRequestException('Season pass revoked');
    }

    const now = new Date();
    if (pass.valid_from.getTime() > now.getTime()) {
      throw new BadRequestException('Season pass is not valid yet');
    }
    if (
      pass.status === 'expired' ||
      pass.valid_until.getTime() < now.getTime()
    ) {
      throw new BadRequestException('Season pass expired');
    }

    const existingScanRows = await this.prisma.$queryRaw<
      { id: string; entry_id: string | null }[]
    >(Prisma.sql`
      SELECT id, entry_id
      FROM venue_pr_membership_pass_scans
      WHERE pass_id = ${pass.id}::uuid
        AND event_id = ${event.id}::uuid
        AND scan_result = 'accepted'
      ORDER BY scanned_at DESC
      LIMIT 1
    `);

    const existingScan = existingScanRows[0] ?? null;
    if (existingScan) {
      const existingEntry = existingScan.entry_id
        ? await this.prisma.entries.findUnique({
            where: { id: existingScan.entry_id },
          })
        : null;
      return {
        success: true,
        alreadyCheckedIn: true,
        reservation: null,
        entry: existingEntry ?? undefined,
      };
    }

    const userProfile = await this.prisma.users.findUnique({
      where: { id: pass.user_id },
      select: { id: true, sesso: true, birth_date: true },
    });

    const gender =
      userProfile?.sesso === 'M'
        ? Gender.M
        : userProfile?.sesso === 'F'
          ? Gender.F
          : Gender.ALTRO;

    const ageBucket = this.ageBucketFromBirthDate(
      userProfile?.birth_date ?? null,
      new Date(),
    );

    const entryPrice = await resolveEntryUnitPrice({
      prisma: this.prisma,
      eventId: event.id,
      gender,
      isComplimentary: true,
    });

    let createdEntry;
    try {
      createdEntry = await this.prisma.$transaction(async (tx) => {
        const entry = await tx.entries.create({
          data: {
            event_id: event.id,
            user_id: pass.user_id,
            staff_id: params.staffId,
            pr_membership_id: pass.pr_membership_id,
            sesso: gender,
            age_bucket: ageBucket,
            price: entryPrice,
            is_complimentary: true,
            method: EntryMethod.QR,
          },
        });

        // A unique partial index on (pass_id, event_id) WHERE scan_result='accepted' is
        // the real guard here (migration 20260814130000) - the pre-check above ran before
        // this transaction, so it can't stop two near-simultaneous scans on its own. The
        // loser of the race hits a unique-violation on this insert instead.
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO venue_pr_membership_pass_scans (
            id,
            pass_id,
            venue_id,
            event_id,
            pr_membership_id,
            scanned_by_user_id,
            entry_id,
            scan_result,
            qr_payload,
            scanned_at,
            created_at
          )
          VALUES (
            ${randomUUID()}::uuid,
            ${pass.id}::uuid,
            ${pass.venue_id}::uuid,
            ${event.id}::uuid,
            ${pass.pr_membership_id}::uuid,
            ${params.staffId}::uuid,
            ${entry.id}::uuid,
            'accepted',
            ${params.qrData},
            NOW(),
            NOW()
          )
        `);

        return entry;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2010' &&
        String((error.meta as { code?: string } | undefined)?.code) === '23505'
      ) {
        const winnerRows = await this.prisma.$queryRaw<
          { id: string; entry_id: string | null }[]
        >(Prisma.sql`
          SELECT id, entry_id
          FROM venue_pr_membership_pass_scans
          WHERE pass_id = ${pass.id}::uuid
            AND event_id = ${event.id}::uuid
            AND scan_result = 'accepted'
          ORDER BY scanned_at DESC
          LIMIT 1
        `);
        const winner = winnerRows[0] ?? null;
        const winnerEntry = winner?.entry_id
          ? await this.prisma.entries.findUnique({
              where: { id: winner.entry_id },
            })
          : null;
        return {
          success: true,
          alreadyCheckedIn: true,
          reservation: null,
          entry: winnerEntry ?? undefined,
        };
      }
      throw error;
    }

    this.evaluateBadges(pass.user_id);

    return {
      success: true,
      alreadyCheckedIn: false,
      reservation: null,
      entry: createdEntry,
    };
  }

  private formatIncomingTableInvitation(params: {
    reservation: {
      id: string;
      user_id: string;
      table_name?: string | null;
      status: string;
      guests: number;
      total_amount?: Prisma.Decimal | number | string | null;
      created_at: Date;
      meta?: unknown;
      user?: {
        id: string;
        name?: string | null;
        username?: string | null;
      } | null;
      event?: {
        id: string;
        name: string;
        date?: Date | string | null;
        start_time?: Date | string | null;
        end_time?: Date | string | null;
        venue_id?: string | null;
      } | null;
      venue_table_zone?: {
        id: string;
        name?: string | null;
      } | null;
    };
    invite: TableInviteMetaItem;
    venue?: { id: string; name: string; city?: string | null } | null;
    invitedGroupNames?: string[];
  }) {
    const reservationMeta = this.parseTableReservationMeta(
      params.reservation.meta,
    );
    const totalAmountRaw = params.reservation.total_amount;

    return {
      reservation_id: params.reservation.id,
      invitation_status: params.invite.status,
      reservation_status: params.reservation.status,
      invited_at: params.reservation.created_at,
      responded_at: params.invite.responded_at ?? null,
      guests: params.reservation.guests,
      table_name: params.reservation.table_name ?? null,
      zone_label: this.resolveZoneLabel(params.reservation),
      total_amount:
        totalAmountRaw === null || totalAmountRaw === undefined
          ? null
          : Number(totalAmountRaw),
      inviter: {
        id: params.reservation.user_id,
        name:
          reservationMeta?.inviter_name ||
          params.reservation.user?.name ||
          params.reservation.user?.username ||
          'Un amico',
      },
      event: params.reservation.event
        ? {
            id: params.reservation.event.id,
            name: params.reservation.event.name,
            date: params.reservation.event.date,
            start_time: params.reservation.event.start_time ?? null,
            end_time: params.reservation.event.end_time ?? null,
          }
        : null,
      venue: params.venue
        ? {
            id: params.venue.id,
            name: params.venue.name,
            city: params.venue.city ?? null,
          }
        : null,
      invited_group_names: params.invitedGroupNames ?? [],
      can_respond:
        params.reservation.status !== 'cancelled' &&
        params.invite.status === 'pending',
    };
  }

  private async notifyInvitedFriendsOfNewTableReservation(reservation: {
    id: string;
    table_name?: string | null;
    meta?: unknown;
    event?: { name: string | null } | null;
  }) {
    const meta = this.parseTableReservationMeta(reservation.meta);
    if (!meta?.table_invites.length) return;

    const inviterName = meta.inviter_name || 'Un amico';
    const tableLabel =
      reservation.table_name?.trim() || reservation.event?.name || 'la serata';

    await Promise.allSettled(
      meta.table_invites.map((invite) =>
        this.pushDispatch.notifyUser(invite.user_id, {
          title: 'Invito al tavolo',
          body: `${inviterName} ti ha invitato al tavolo per ${tableLabel}.`,
          data: {
            type: 'table_invitation_received',
            reservation_id: reservation.id,
          },
        }),
      ),
    );
  }

  private async notifyTableInviteesAboutStatusChange(reservation: {
    id: string;
    user_id: string | null;
    status: string;
    table_name?: string | null;
    meta?: unknown;
    event?: { name: string | null } | null;
  }) {
    const meta = this.parseTableReservationMeta(reservation.meta);
    const activeInviteeIds = (meta?.table_invites ?? [])
      .filter((invite) => invite.status !== 'declined')
      .map((invite) => invite.user_id);

    // Notify the person who actually made the booking too, not just the invitees they
    // added - this used to be silently skipped, so a venue confirming/cancelling a
    // reservation never reached the booker themselves, only whoever they'd invited.
    // Table reservations always belong to a real account in practice (guest-join only
    // ever creates "entry" reservations), but user_id is nullable on the shared type.
    const recipientIds = Array.from(
      new Set(
        [reservation.user_id, ...activeInviteeIds].filter((id): id is string =>
          Boolean(id),
        ),
      ),
    );
    if (!recipientIds.length) return;

    const tableLabel =
      reservation.table_name?.trim() || reservation.event?.name || 'la serata';
    const body =
      reservation.status === 'confirmed'
        ? `Il tavolo per ${tableLabel} è stato confermato.`
        : reservation.status === 'cancelled'
          ? `Il tavolo per ${tableLabel} è stato annullato.`
          : `Aggiornamento sul tavolo per ${tableLabel}.`;

    await Promise.allSettled(
      recipientIds.map((recipientId) =>
        this.pushDispatch.notifyUser(recipientId, {
          title:
            reservation.status === 'confirmed'
              ? 'Tavolo confermato'
              : reservation.status === 'cancelled'
                ? 'Tavolo annullato'
                : 'Aggiornamento tavolo',
          body,
          data: {
            type: 'table_invitation_updated',
            reservation_id: reservation.id,
            reservation_status: reservation.status,
          },
        }),
      ),
    );
  }

  /** New-reservation notifications for the people who care but aren't the booker: the PR
   * whose link/code the booking is attributed to ("lista aggiornata"), and the venue account
   * that operates the event ("nuova prenotazione"). Neither had any hook before this. */
  private async notifyNewReservationInterestedParties(params: {
    reservationId: string;
    type: 'entry' | 'table';
    eventName: string | null;
    venueId: string | null | undefined;
    prMembershipUserId: string | null | undefined;
  }) {
    const eventLabel = params.eventName || 'un evento';
    const kindLabel = params.type === 'table' ? 'un tavolo' : 'la lista';

    const notifications: Promise<void>[] = [];

    if (params.prMembershipUserId) {
      notifications.push(
        this.pushDispatch.notifyUser(params.prMembershipUserId, {
          title: 'Nuova persona in lista',
          body: `Qualcuno ha prenotato ${kindLabel} per ${eventLabel} tramite il tuo link.`,
          data: {
            type: 'pr_referral_reservation',
            reservation_id: params.reservationId,
          },
        }),
      );
    }

    if (params.venueId) {
      const venueOperators = await this.prisma.users.findMany({
        where: { role: 'venue', venue_id: params.venueId },
        select: { id: true },
      });
      for (const operator of venueOperators) {
        notifications.push(
          this.pushDispatch.notifyUser(operator.id, {
            title: 'Nuova prenotazione',
            body: `Nuova prenotazione (${kindLabel}) per ${eventLabel}.`,
            data: {
              type: 'venue_new_reservation',
              reservation_id: params.reservationId,
            },
          }),
        );
      }
    }

    await Promise.allSettled(notifications);
  }

  /** Entry ("lista") reservations used to notify nobody on confirm/cancel - only table
   * bookings did, via notifyTableInviteesAboutStatusChange. */
  private async notifyEntryReservationStatusChange(reservation: {
    id: string;
    user_id: string | null;
    status: string;
    event?: { name: string | null } | null;
  }) {
    // Guest (unauthenticated) entry reservations have no account to push to.
    if (!reservation.user_id) return;

    const eventLabel = reservation.event?.name || 'la serata';
    const title =
      reservation.status === 'confirmed'
        ? 'Sei in lista'
        : reservation.status === 'cancelled'
          ? 'Prenotazione annullata'
          : 'Aggiornamento prenotazione';
    const body =
      reservation.status === 'confirmed'
        ? `Sei in lista per ${eventLabel}.`
        : reservation.status === 'cancelled'
          ? `La tua prenotazione per ${eventLabel} è stata annullata.`
          : `Aggiornamento sulla tua prenotazione per ${eventLabel}.`;

    await this.pushDispatch.notifyUser(reservation.user_id, {
      title,
      body,
      data: {
        type: 'entry_reservation_updated',
        reservation_id: reservation.id,
        reservation_status: reservation.status,
      },
    });
  }

  async listIncomingTableInvitations(userId: string) {
    // Invite membership lives inside the JSON `meta` column, so it can't be filtered in
    // SQL directly. Scope to non-cancelled reservations (cancelled invites are no longer
    // "incoming") and cap the scan so this stays bounded as the table grows.
    const reservations = await this.prisma.reservations.findMany({
      where: { type: 'table', status: { not: 'cancelled' } },
      orderBy: { created_at: 'desc' },
      take: 2000,
      select: incomingTableInvitationReservationSelect,
    });

    const invitations = reservations
      .map((reservation) => {
        const meta = this.parseTableReservationMeta(reservation.meta);
        if (!meta) return null;
        const invite = meta.table_invites.find((row) => row.user_id === userId);
        if (!invite) return null;
        return { reservation, invite, meta };
      })
      .filter(
        (
          row,
        ): row is {
          reservation: IncomingTableInvitationReservation & {
            user_id: string;
          };
          invite: TableInviteMetaItem;
          meta: TableReservationMeta;
        } =>
          // Table reservations always belong to a real account (guest-join only ever
          // creates "entry" reservations) - this narrows the type back to non-null for
          // formatIncomingTableInvitation below.
          row !== null && Boolean(row.reservation.user_id),
      );

    if (!invitations.length) return [];

    const venueIds = Array.from(
      new Set(
        invitations
          .map((row) => row.reservation.event?.venue_id)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const groupIds = Array.from(
      new Set(invitations.flatMap((row) => row.meta.invited_group_ids)),
    );

    const venueQuery: Promise<
      Array<{ id: string; name: string; city: string | null }>
    > = venueIds.length
      ? this.prisma.venues.findMany({
          where: { id: { in: venueIds } },
          select: { id: true, name: true, city: true },
        })
      : Promise.resolve([]);
    const groupQuery: Promise<Array<{ id: string; name: string }>> =
      groupIds.length
        ? this.prisma.friend_groups.findMany({
            where: { id: { in: groupIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]);

    const [venues, groups] = await Promise.all([venueQuery, groupQuery]);

    const venueMap = new Map<
      string,
      { id: string; name: string; city?: string | null }
    >(venues.map((venue) => [venue.id, venue] as const));
    const groupMap = new Map<string, string>(
      groups.map((group) => [group.id, group.name] as const),
    );

    return invitations.map(({ reservation, invite, meta }) =>
      this.formatIncomingTableInvitation({
        reservation,
        invite,
        venue: reservation.event?.venue_id
          ? (venueMap.get(reservation.event.venue_id) ?? null)
          : null,
        invitedGroupNames: meta.invited_group_ids
          .map((groupId) => groupMap.get(groupId))
          .filter((value): value is string => Boolean(value)),
      }),
    );
  }

  async respondToTableInvitation(params: {
    reservationId: string;
    userId: string;
    response: 'accepted' | 'declined';
  }) {
    const reservation = await this.prisma.reservations.findUnique({
      where: { id: params.reservationId },
      select: tableInvitationResponseReservationSelect,
    });

    if (
      !reservation ||
      reservation.status === 'cancelled' ||
      !reservation.user_id
    ) {
      // Table reservations always belong to a real account (guest-join only ever creates
      // "entry" reservations) - a missing user_id here means there's no valid invitation.
      throw new NotFoundException('Table invitation not found');
    }
    // Narrowed once, up front - property narrowing on `reservation.user_id` doesn't
    // reliably survive the awaits below.
    const bookerUserId: string = reservation.user_id;

    const meta = this.parseTableReservationMeta(reservation.meta);
    const inviteIndex =
      meta?.table_invites.findIndex(
        (invite) => invite.user_id === params.userId,
      ) ?? -1;
    if (!meta || inviteIndex < 0) {
      throw new NotFoundException('Table invitation not found');
    }

    const updatedInvites = [...meta.table_invites];
    updatedInvites[inviteIndex] = {
      ...updatedInvites[inviteIndex],
      status: params.response,
      responded_at: new Date().toISOString(),
    };

    const updatedMeta = {
      ...meta,
      table_invites: updatedInvites,
    } satisfies TableReservationMeta;

    await this.prisma.reservations.update({
      where: { id: params.reservationId },
      data: { meta: updatedMeta as Prisma.InputJsonValue },
    });

    const responder = await this.prisma.users.findUnique({
      where: { id: params.userId },
      select: { name: true, username: true },
    });

    {
      const responderName =
        responder?.name || responder?.username || 'Un amico';
      const voteText =
        params.response === 'accepted'
          ? 'ha confermato la presenza'
          : "ha rifiutato l'invito";
      await this.pushDispatch.notifyUser(bookerUserId, {
        title: 'Risposta invito tavolo',
        body: `${responderName} ${voteText}.`,
        data: {
          type: 'table_invitation_response',
          reservation_id: reservation.id,
        },
      });
    }

    const venue = reservation.event?.venue_id
      ? await this.prisma.venues.findUnique({
          where: { id: reservation.event.venue_id },
          select: { id: true, name: true, city: true },
        })
      : null;
    const groups = meta.invited_group_ids.length
      ? await this.prisma.friend_groups.findMany({
          where: { id: { in: meta.invited_group_ids } },
          select: { id: true, name: true },
        })
      : [];

    return this.formatIncomingTableInvitation({
      reservation: { ...reservation, user_id: bookerUserId },
      invite: updatedInvites[inviteIndex],
      venue,
      invitedGroupNames: groups.map((group) => group.name),
    });
  }

  async updateReservation(
    id: string,
    updates: Prisma.reservationsUpdateInput & { status?: unknown },
  ) {
    const existing = await this.getReservation(id);
    const nextStatus = this.normalizeReservationStatusUpdate(
      (updates as Record<string, unknown>).status,
    );
    if (nextStatus !== undefined) {
      this.assertValidReservationStatusTransition(
        existing.status as 'pending' | 'confirmed' | 'cancelled' | 'completed',
        nextStatus,
      );
      updates.status = nextStatus;
    }

    if (existing.type === 'table') {
      const nextGuests = this.parseGuestsUpdateValue(
        (updates as Record<string, unknown>).guests,
      );
      const nextTotalAmount = this.parseTotalAmountUpdateValue(
        (updates as Record<string, unknown>).total_amount,
      );

      const effectiveGuests = nextGuests ?? existing.guests;
      const effectiveStatus = nextStatus ?? existing.status;

      const hasPricingRelevantUpdate =
        nextGuests !== undefined || nextTotalAmount !== undefined;

      if (hasPricingRelevantUpdate) {
        if (nextGuests !== undefined && existing.venue_table_zone_id) {
          const computedTotal = await this.computeZoneTotalAmount({
            eventId: existing.event_id,
            venueTableZoneId: existing.venue_table_zone_id,
            guests: effectiveGuests,
          });

          if (computedTotal) {
            updates.total_amount = computedTotal;
          } else if (nextTotalAmount !== undefined) {
            updates.total_amount =
              nextTotalAmount === null
                ? null
                : new Prisma.Decimal(nextTotalAmount);
          } else if (existing.total_amount !== null && existing.guests > 0) {
            const scaled =
              Number(existing.total_amount) *
              (effectiveGuests / existing.guests);
            if (Number.isFinite(scaled) && scaled >= 0) {
              updates.total_amount = new Prisma.Decimal(scaled);
            }
          }
        } else if (nextTotalAmount !== undefined) {
          updates.total_amount =
            nextTotalAmount === null
              ? null
              : new Prisma.Decimal(nextTotalAmount);
        } else if (
          nextGuests !== undefined &&
          existing.total_amount !== null &&
          existing.guests > 0
        ) {
          const scaled =
            Number(existing.total_amount) * (effectiveGuests / existing.guests);
          if (Number.isFinite(scaled) && scaled >= 0) {
            updates.total_amount = new Prisma.Decimal(scaled);
          }
        }
      }

      if (
        this.isActiveTableReservationStatus(effectiveStatus) &&
        !existing.venue_table_zone_id
      ) {
        throw new BadRequestException(
          'venue_table_zone_id required for table reservations',
        );
      }
    }

    const updated = await (async () => {
      try {
        return await this.prisma.reservations.update({
          where: { id },
          data: updates,
          include: {
            user: {
              select: { id: true, name: true, email: true, phone: true },
            },
            event: {
              select: {
                id: true,
                venue_id: true,
                name: true,
                date: true,
                start_time: true,
                end_time: true,
              },
            },
            venue_table_zone: true,
          },
        });
      } catch (error: unknown) {
        const { code: prismaCode, message } = this.getErrorDetails(error);
        const errorMessage = message.toLowerCase();
        if (
          prismaCode === 'P2002' ||
          errorMessage.includes(
            'reservations_unique_active_user_event_type_idx',
          ) ||
          errorMessage.includes(
            'duplicate key value violates unique constraint',
          )
        ) {
          throw new BadRequestException(
            'Hai già un tavolo prenotato per questa serata',
          );
        }
        throw error;
      }
    })();

    const updatedFull = await this.getReservation(updated.id);

    if (nextStatus !== undefined && nextStatus !== existing.status) {
      if (existing.type === 'table') {
        await this.notifyTableInviteesAboutStatusChange(updatedFull);
      } else {
        await this.notifyEntryReservationStatusChange(updatedFull);
      }
    }

    return updatedFull;
  }

  async cancelReservation(id: string) {
    const existing = await this.getReservation(id);
    const updated = await this.prisma.reservations.update({
      where: { id },
      data: { status: 'cancelled' },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true },
        },
        event: {
          select: {
            id: true,
            venue_id: true,
            name: true,
            date: true,
            start_time: true,
            end_time: true,
          },
        },
        venue_table_zone: true,
      },
    });

    const updatedFull = await this.getReservation(updated.id);

    if (existing.type === 'table') {
      await this.notifyTableInviteesAboutStatusChange(updatedFull);
    } else {
      await this.notifyEntryReservationStatusChange(updatedFull);
    }

    return updatedFull;
  }

  // Called by the sync-status cron endpoint. A table reservation the venue never responds
  // to (still `pending`) has no natural end otherwise - this is what gives it one. Entry
  // reservations don't need this: they're created directly `confirmed` in the common case
  // (see createReservation) and aren't awaiting venue approval the same way.
  private static readonly PENDING_RESERVATION_TTL_HOURS = 24;

  async expireStalePendingReservations() {
    const cutoff = new Date(
      Date.now() -
        ReservationsService.PENDING_RESERVATION_TTL_HOURS * 60 * 60 * 1000,
    );

    const { count } = await this.prisma.reservations.updateMany({
      where: {
        type: 'table',
        status: 'pending',
        created_at: { lt: cutoff },
      },
      data: { status: 'cancelled' },
    });

    return { success: true, expired: count };
  }

  // How far ahead of an event's actual start (see eventStartMs) a "evento imminente"
  // reminder fires. Called by an external scheduler, same pattern as syncStatus above -
  // there is no in-process scheduler on a serverless deployment, so this can't be a
  // setInterval/@Cron: nothing stays running between requests.
  private static readonly REMINDER_WINDOW_HOURS = 3;

  async sendUpcomingEventReminders() {
    const now = Date.now();
    const horizon = new Date(
      now + ReservationsService.REMINDER_WINDOW_HOURS * 60 * 60 * 1000,
    );

    // Narrow with the DATE column first (cheap, indexed-ish via btree on a date range) -
    // the precise timezone-aware start instant is only computed for this small candidate
    // set, not the whole table.
    const candidates = await this.prisma.reservations.findMany({
      where: {
        status: { in: ['pending', 'confirmed'] },
        reminder_sent_at: null,
        event: {
          date: { gte: new Date(now - 24 * 60 * 60 * 1000), lte: horizon },
        },
      },
      select: {
        id: true,
        user_id: true,
        event: { select: { name: true, date: true, start_time: true } },
      },
      take: 500,
    });

    const due = candidates.filter(
      (
        reservation,
      ): reservation is typeof reservation & { user_id: string } => {
        if (!reservation.user_id) return false; // guests have no account to push to
        const startMs = eventStartMs(reservation.event);
        return (
          startMs !== null && startMs >= now && startMs <= horizon.getTime()
        );
      },
    );

    if (!due.length) return { success: true, reminded: 0 };

    await Promise.allSettled(
      due.map((reservation) =>
        this.pushDispatch.notifyUser(reservation.user_id, {
          title: 'Evento imminente',
          body: `${reservation.event?.name || 'Il tuo evento'} inizia tra poche ore.`,
          data: {
            type: 'event_reminder',
            reservation_id: reservation.id,
          },
        }),
      ),
    );

    await this.prisma.reservations.updateMany({
      where: { id: { in: due.map((reservation) => reservation.id) } },
      data: { reminder_sent_at: new Date() },
    });

    return { success: true, reminded: due.length };
  }

  // Hostess: marks a confirmed table reservation as arrived at the venue - this is what
  // flips a table from "confirmed" to "completed" (entries instead become `completed` via
  // scanEntryQr()). Only confirmed tables can arrive: pending ones haven't been approved by
  // the venue yet, and cancelled/already-completed ones can't transition again.
  async checkinTableReservation(
    id: string,
    staffId: string,
    actualGuests?: unknown,
  ) {
    const existing = await this.getReservation(id);

    if (existing.type !== 'table') {
      throw new BadRequestException(
        'Only table reservations can be checked in this way',
      );
    }
    if (existing.status !== 'confirmed') {
      throw new BadRequestException(
        'Only confirmed table reservations can be marked as arrived',
      );
    }

    let normalizedActualGuests: number | undefined;
    if (actualGuests !== undefined && actualGuests !== null) {
      const n = Number(actualGuests);
      if (!Number.isInteger(n) || n < 0) {
        throw new BadRequestException('actual_guests must be an integer >= 0');
      }
      normalizedActualGuests = n;
    }

    const updated = await this.prisma.reservations.update({
      where: { id },
      data: {
        status: 'completed',
        checked_in_at: new Date(),
        checked_in_by_staff_id: staffId,
        ...(normalizedActualGuests !== undefined
          ? { actual_guests: normalizedActualGuests }
          : {}),
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true },
        },
        event: {
          select: {
            id: true,
            venue_id: true,
            name: true,
            date: true,
            start_time: true,
            end_time: true,
          },
        },
        venue_table_zone: true,
      },
    });

    const updatedFull = await this.getReservation(updated.id);
    await this.notifyTableInviteesAboutStatusChange(updatedFull);
    return updatedFull;
  }
}
