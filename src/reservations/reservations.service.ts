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

type QrCheckInResult = {
  success: boolean;
  alreadyCheckedIn: boolean;
  reservation: unknown;
  entry?: unknown;
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
    venue_table: {
      select: { id: true, nome: true, zona: true },
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
    venue_table: {
      select: { id: true, nome: true, zona: true },
    },
  });

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}
  private readonly logger = new Logger(ReservationsService.name);

  private maskToken(token: string) {
    if (!token) return 'empty';
    if (token.length <= 14) return token;
    return `${token.slice(0, 10)}...${token.slice(-4)}`;
  }

  private async sendExpoPush(params: {
    token: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }) {
    const token = String(params.token || '').trim();
    const isExpoToken = /^Expo(?:nent)?PushToken\[[^\]]+\]$/.test(token);
    if (!isExpoToken) return;

    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: token,
          title: params.title,
          body: params.body,
          sound: 'default',
          priority: 'high',
          content_available: true,
          data: params.data ?? {},
        }),
      });

      if (!response.ok) {
        this.logger.warn(
          `Expo push HTTP ${response.status} for ${this.maskToken(token)}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Expo push exception for ${this.maskToken(token)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

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
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
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
    const normalized = String(role ?? '').trim().toLowerCase();
    return (
      normalized === 'responsabile' ||
      normalized === 'capo_squadra' ||
      normalized === 'pr'
    );
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
    venue_table?: { zona?: string | null; nome?: string | null } | null;
    meta?: unknown;
  }) {
    const explicitZone = String(reservation.venue_table?.zona ?? '').trim();
    if (explicitZone) return explicitZone;
    const tableName = String(reservation.venue_table?.nome ?? '').trim();
    if (tableName) return tableName;
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

  async listBookedTableIdsForEvent(eventId: string): Promise<string[]> {
    const rows = await this.prisma.reservations.findMany({
      where: {
        event_id: eventId,
        type: 'table',
        // Cancelled reservations should not block the table.
        status: { not: 'cancelled' },
        venue_table_id: { not: null },
      },
      select: { venue_table_id: true },
    });

    const out = new Set<string>();
    for (const r of rows) {
      if (r.venue_table_id) out.add(r.venue_table_id);
    }
    return Array.from(out);
  }

  private reservationSelect() {
    return {
      id: true,
      user_id: true,
      event_id: true,
      venue_table_id: true,
      table_name: true,
      meta: true,
      type: true,
      status: true,
      guests: true,
      total_amount: true,
      qr_token: true,
      qr_payload: true,
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
            },
          },
        },
      },
      venue_table: {
        select: {
          id: true,
          venue_id: true,
          nome: true,
          zona: true,
          numero: true,
          persone_max: true,
          per_testa: true,
          costo_minimo: true,
        },
      },
    } satisfies Prisma.reservationsSelect;
  }

  private buildEntryQrPayload(params: {
    reservationId: string;
    userId: string;
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

  private parseQrData(raw: string): {
    qrToken?: string;
    reservationId?: string;
    userId?: string;
    eventId?: string;
  } {
    const value = String(raw ?? '').trim();
    if (!value) return {};

    if (value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value) as Record<string, unknown>;
        return {
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
        };
      } catch {
        return {};
      }
    }

    return { qrToken: value, userId: value };
  }

  private normalizeCreateReservationDto(
    dto: Record<string, unknown> | null | undefined,
  ): {
    user_id?: string;
    event_id?: string;
    type?: 'table' | 'entry';
    guests?: unknown;
    venue_table_id?: string | null;
    table_name?: unknown;
    meta?: unknown;
    status?: 'pending' | 'confirmed' | 'cancelled' | 'completed';
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
    const venue_table_id =
      this.normalizeStringValue(
        payload.venue_zone_id ??
          payload.venueZoneId ??
          payload.venue_table_id ??
          payload.venueTableId ??
          payload.table_id ??
          payload.tableId,
      ) || null;
    const total_amount = payload.total_amount ?? payload.totalAmount;
    const table_name = payload.table_name ?? payload.tableName;
    const meta = payload.meta;

    let status = payload.status;
    if (status === 'reserved') status = 'confirmed';

    const normalizedStatus =
      status === 'pending' ||
      status === 'confirmed' ||
      status === 'cancelled' ||
      status === 'completed'
        ? status
        : undefined;

    return {
      user_id,
      event_id,
      type,
      guests,
      venue_table_id,
      table_name,
      meta,
      status: normalizedStatus,
      total_amount,
    };
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

  private parseTableIdUpdateValue(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    const raw = this.unwrapSetField(value);
    if (raw === null) return null;

    if (typeof raw !== 'string' && typeof raw !== 'number') {
      throw new BadRequestException('venue_table_id must be a string');
    }

    const next = String(raw).trim();
    return next.length ? next : null;
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

  private async computeTableTotalAmount(params: {
    eventId: string;
    venueTableId: string;
    guests: number;
  }): Promise<Prisma.Decimal | null> {
    const [table, eventTableCount, eventTableRows] = await Promise.all([
      this.prisma.venue_tables.findUnique({
        where: { id: params.venueTableId },
        select: {
          id: true,
          venue_id: true,
          per_testa: true,
          costo_minimo: true,
          persone_max: true,
        },
      }),
      this.prisma.event_tables.count({
        where: { event_id: params.eventId },
      }),
      this.prisma.event_tables.findMany({
        where: {
          event_id: params.eventId,
          venue_table_id: params.venueTableId,
        },
        select: {
          per_testa_override: true,
          costo_minimo_override: true,
          persone_max_override: true,
        },
        take: 1,
      }),
    ]);

    if (!table) throw new NotFoundException('Table not found');

    const eventTable = eventTableRows[0] ?? null;
    if (eventTableCount > 0 && !eventTable) {
      throw new BadRequestException(
        'Selected table is not enabled for this event',
      );
    }

    const eventOverridePerTesta: unknown = eventTable?.per_testa_override;
    const eventOverrideCostoMinimo: unknown = eventTable?.costo_minimo_override;
    const eventOverridePersoneMax: unknown = eventTable?.persone_max_override;

    const effectivePerTesta: Prisma.Decimal | null =
      eventOverridePerTesta === null || eventOverridePerTesta === undefined
        ? (table.per_testa ?? null)
        : (eventOverridePerTesta as Prisma.Decimal);
    const effectiveCostoMinimo: Prisma.Decimal | null =
      eventOverrideCostoMinimo === null ||
      eventOverrideCostoMinimo === undefined
        ? (table.costo_minimo ?? null)
        : (eventOverrideCostoMinimo as Prisma.Decimal);
    const effectivePersoneMax: number | null =
      eventOverridePersoneMax === null || eventOverridePersoneMax === undefined
        ? (table.persone_max ?? null)
        : Number(eventOverridePersoneMax);

    if (effectivePersoneMax && params.guests > effectivePersoneMax) {
      throw new BadRequestException('guests exceeds table persone_max');
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
    return this.prisma.reservations.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: this.reservationSelect(),
    });
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

    const event = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { id: true, venue_id: true },
    });
    if (!event) throw new NotFoundException('Event not found');

    // ❗ Saltiamo il controllo duplicati se è un account venue
    const userRecord = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (userRecord?.role !== 'venue') {
      const existingReservationForEvent =
        await this.prisma.reservations.findFirst({
          where: {
            user_id: userId,
            event_id: eventId,
            status: { in: ['pending', 'confirmed', 'completed'] },
          },
          select: { id: true },
        });

      if (existingReservationForEvent) {
        throw new BadRequestException(
          'Hai già una prenotazione per questa serata',
        );
      }
    }

    const incomingMeta = this.asObjectRecord(normalized.meta);
    const referralCode = this.parseTrackingCodeFromMeta(incomingMeta);
    const invitedByUserId = this.readMetaString(incomingMeta, 'inviter_user_id');
    const prMembershipOrFilters: Prisma.venue_pr_membershipsWhereInput[] = [
      ...(referralCode
        ? [{ ref_code: { equals: referralCode, mode: 'insensitive' as const } }]
        : []),
      ...(invitedByUserId ? [{ user_id: invitedByUserId }] : []),
    ];

    const prMembership =
      (referralCode || invitedByUserId) && event?.venue_id
        ? await this.prisma.venue_pr_memberships.findFirst({
            where: {
              venue_id: event.venue_id,
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
      type === 'entry' &&
      Boolean(prMembership && this.roleHasDefaultPrComplimentary(prMembership.role));

    const referralMeta: ReservationReferralMeta | null =
      prMembership || referralCode || invitedByUserId
        ? {
            inviter_user_id: prMembership?.user_id ?? invitedByUserId,
            tracking_code: prMembership?.ref_code ?? referralCode,
            pr_code: prMembership?.ref_code ?? referralCode,
            ref_code: prMembership?.ref_code ?? referralCode,
            promo_code: prMembership?.ref_code ?? referralCode,
            pr_membership_id: prMembership?.id,
            pr_role: prMembership?.role,
            pr_omaggio_default: isPrComplimentaryEntry,
            wallet_pass_eligible: isPrComplimentaryEntry,
          }
        : null;

    const venueTableId: string | null | undefined =
      normalized.venue_table_id ?? null;
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
      if (!venueTableId) {
        throw new BadRequestException(
          'venue_zone_id required for table reservations',
        );
      }

      const [table, eventTableCount, eventTableRows] = await Promise.all([
        this.prisma.venue_tables.findUnique({
          where: { id: venueTableId },
          select: {
            id: true,
            venue_id: true,
            per_testa: true,
            costo_minimo: true,
            persone_max: true,
          },
        }),
        this.prisma.event_tables.count({
          where: { event_id: eventId },
        }),
        this.prisma.event_tables.findMany({
          where: {
            event_id: eventId,
            venue_table_id: venueTableId,
          },
          select: {
            per_testa_override: true,
            costo_minimo_override: true,
            persone_max_override: true,
          },
          take: 1,
        }),
      ]);
      const eventTable = eventTableRows[0] ?? null;
      if (!table) throw new NotFoundException('Table not found');
      if (table.venue_id !== event.venue_id) {
        throw new BadRequestException(
          'Selected table does not belong to this event venue',
        );
      }

      if (eventTableCount > 0 && !eventTable) {
        throw new BadRequestException(
          'Selected table is not enabled for this event',
        );
      }

      const eventOverridePerTesta: unknown = eventTable?.per_testa_override;
      const eventOverrideCostoMinimo: unknown =
        eventTable?.costo_minimo_override;
      const eventOverridePersoneMax: unknown = eventTable?.persone_max_override;

      const effectivePerTesta: Prisma.Decimal | null =
        eventOverridePerTesta === null || eventOverridePerTesta === undefined
          ? (table.per_testa ?? null)
          : (eventOverridePerTesta as Prisma.Decimal);
      const effectiveCostoMinimo: Prisma.Decimal | null =
        eventOverrideCostoMinimo === null ||
        eventOverrideCostoMinimo === undefined
          ? (table.costo_minimo ?? null)
          : (eventOverrideCostoMinimo as Prisma.Decimal);
      const effectivePersoneMax: number | null =
        eventOverridePersoneMax === null ||
        eventOverridePersoneMax === undefined
          ? (table.persone_max ?? null)
          : Number(eventOverridePersoneMax);

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

    const status = normalized?.status;
    if (
      status !== undefined &&
      status !== 'pending' &&
      status !== 'confirmed' &&
      status !== 'cancelled' &&
      status !== 'completed'
    ) {
      throw new BadRequestException(
        'status must be pending|confirmed|cancelled|completed',
      );
    }

    const qrToken = type === 'entry' ? randomUUID() : undefined;

    const createdReservation = await (async () => {
      try {
        return await this.prisma.reservations.create({
          data: {
            user_id: userId,
            event_id: eventId,
            venue_table_id: type === 'table' ? venueTableId : null,
            table_name: type === 'table' ? tableName : null,
            meta: reservationMeta,
            type,
            status,
            guests,
            total_amount: totalAmount,
            qr_token: qrToken,
          },
          include: {
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
              },
            },
            venue_table: true,
          },
        });
      } catch (error: unknown) {
        const { code: prismaCode, message } = this.getErrorDetails(error);
        const errorMessage = message.toLowerCase();
        if (
          prismaCode === 'P2002' ||
          errorMessage.includes('reservations_unique_active_user_event_idx') ||
          errorMessage.includes(
            'duplicate key value violates unique constraint',
          )
        ) {
          throw new BadRequestException(
            'Hai già una prenotazione per questa serata',
          );
        }
        throw error;
      }
    })();

    const createdId = createdReservation.id;
    let finalReservation = createdReservation;

    if (type === 'table') {
      const createdWithMeta = await this.getReservation(createdId);
      await this.notifyInvitedFriendsOfNewTableReservation(createdWithMeta);
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
      include: {
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
          },
        },
        venue_table: true,
      },
    });
  }

  async checkInEntryReservationByQr(params: {
    eventId: string;
    staffId: string;
    qrData: string;
  }): Promise<QrCheckInResult> {
    const eventId = String(params.eventId ?? '').trim();
    const staffId = String(params.staffId ?? '').trim();
    const qrData = String(params.qrData ?? '').trim();

    if (!eventId) throw new BadRequestException('event_id required');
    if (!staffId) throw new BadRequestException('staff_id required');
    if (!qrData) throw new BadRequestException('qr_data required');

    const parsed = this.parseQrData(qrData);

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
          event: { select: { id: true, name: true, venue_id: true, date: true } },
        },
      });
    }

    if (!reservation && parsed.userId) {
      reservation = await this.prisma.reservations.findFirst({
        where: {
          user_id: parsed.userId,
          event_id: eventId,
          type: 'entry',
          status: { in: ['pending', 'confirmed', 'completed'] },
        },
        orderBy: { created_at: 'desc' },
        include: {
          user: {
            select: { id: true, sesso: true, name: true, birth_date: true },
          },
          event: { select: { id: true, name: true, venue_id: true, date: true } },
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

    const result = await this.prisma.$transaction(async (tx) => {
      const createdEntry = await tx.entries.create({
        data: {
          event_id: eventId,
          user_id: reservation.user_id,
          staff_id: staffId,
          sesso: gender,
          price: entryPrice,
          is_complimentary: reservationIsComplimentary,
          age_bucket: ageBucket,
          method: EntryMethod.QR,
        },
      });

      const updatedReservation = await tx.reservations.update({
        where: { id: reservation.id },
        data: {
          status: 'completed',
          checked_in_at: new Date(),
          checked_in_by_staff_id: staffId,
          checkin_entry_id: createdEntry.id,
        },
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
          venue_table: true,
        },
      });

      return { createdEntry, updatedReservation };
    });

    return {
      success: true,
      alreadyCheckedIn: false,
      reservation: result.updatedReservation,
      entry: result.createdEntry,
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
      venue_table?: {
        id: string;
        nome?: string | null;
        zona?: string | null;
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

    const recipients = await this.prisma.users.findMany({
      where: {
        id: { in: meta.table_invites.map((invite) => invite.user_id) },
        push_token: { not: null },
      },
      select: { id: true, push_token: true },
    });

    if (!recipients.length) return;

    const inviterName = meta.inviter_name || 'Un amico';
    const tableLabel =
      reservation.table_name?.trim() || reservation.event?.name || 'la serata';

    await Promise.allSettled(
      recipients
        .filter((recipient): recipient is { id: string; push_token: string } =>
          Boolean(recipient.push_token),
        )
        .map((recipient) =>
          this.sendExpoPush({
            token: recipient.push_token,
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
    status: string;
    table_name?: string | null;
    meta?: unknown;
    event?: { name: string | null } | null;
  }) {
    const meta = this.parseTableReservationMeta(reservation.meta);
    if (!meta?.table_invites.length) return;

    const activeInviteeIds = meta.table_invites
      .filter((invite) => invite.status !== 'declined')
      .map((invite) => invite.user_id);
    if (!activeInviteeIds.length) return;

    const recipients = await this.prisma.users.findMany({
      where: {
        id: { in: activeInviteeIds },
        push_token: { not: null },
      },
      select: { push_token: true },
    });

    if (!recipients.length) return;

    const tableLabel =
      reservation.table_name?.trim() || reservation.event?.name || 'la serata';
    const body =
      reservation.status === 'confirmed'
        ? `Il tavolo per ${tableLabel} è stato confermato.`
        : reservation.status === 'cancelled'
          ? `Il tavolo per ${tableLabel} è stato annullato.`
          : `Aggiornamento sul tavolo per ${tableLabel}.`;

    await Promise.allSettled(
      recipients
        .filter((recipient): recipient is { push_token: string } =>
          Boolean(recipient.push_token),
        )
        .map((recipient) =>
          this.sendExpoPush({
            token: recipient.push_token,
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

  async listIncomingTableInvitations(userId: string) {
    const reservations = await this.prisma.reservations.findMany({
      where: { type: 'table' },
      orderBy: { created_at: 'desc' },
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
          reservation: IncomingTableInvitationReservation;
          invite: TableInviteMetaItem;
          meta: TableReservationMeta;
        } => Boolean(row),
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

    if (!reservation || reservation.status === 'cancelled') {
      throw new NotFoundException('Table invitation not found');
    }

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

    if (reservation.user?.push_token) {
      const responderName =
        responder?.name || responder?.username || 'Un amico';
      const voteText =
        params.response === 'accepted'
          ? 'ha confermato la presenza'
          : "ha rifiutato l'invito";
      await this.sendExpoPush({
        token: reservation.user.push_token,
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
      reservation,
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

    if (existing.type === 'table') {
      const nextGuests = this.parseGuestsUpdateValue(
        (updates as Record<string, unknown>).guests,
      );
      const nextTableId = this.parseTableIdUpdateValue(
        (updates as Record<string, unknown>).venue_table_id,
      );
      const nextTotalAmount = this.parseTotalAmountUpdateValue(
        (updates as Record<string, unknown>).total_amount,
      );

      const effectiveGuests = nextGuests ?? existing.guests;
      const effectiveTableId =
        nextTableId === undefined ? existing.venue_table_id : nextTableId;

      const hasPricingRelevantUpdate =
        nextGuests !== undefined ||
        nextTableId !== undefined ||
        nextTotalAmount !== undefined;

      if (hasPricingRelevantUpdate) {
        if (effectiveTableId) {
          const computedTotal = await this.computeTableTotalAmount({
            eventId: existing.event_id,
            venueTableId: effectiveTableId,
            guests: effectiveGuests,
          });

          if (computedTotal) {
            updates.total_amount = computedTotal;
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
    }

    const updated = await this.prisma.reservations.update({
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
        venue_table: true,
      },
    });

    const updatedFull = await this.getReservation(updated.id);

    const nextStatus =
      typeof updates.status === 'string' ? updates.status : undefined;

    if (
      existing.type === 'table' &&
      nextStatus !== undefined &&
      nextStatus !== existing.status
    ) {
      await this.notifyTableInviteesAboutStatusChange(updatedFull);
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
        venue_table: true,
      },
    });

    const updatedFull = await this.getReservation(updated.id);

    if (existing.type === 'table') {
      await this.notifyTableInviteesAboutStatusChange(updatedFull);
    }

    return updatedFull;
  }
}
