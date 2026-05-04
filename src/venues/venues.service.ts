import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../auth/types';
import {
  AgeBucket,
  EntryMethod,
  EventStatus,
  Gender,
  Prisma,
  ReservationStatus,
  ReservationType,
  VenueStationType,
  events,
  promos,
  venue_tables,
  venue_stations,
  venues,
} from '@prisma/client';
import Stripe from 'stripe';
import { resolveEntryUnitPrice } from '../common/entry-pricing';
import { CreateVenueTablesBulkDto } from './dto/create-venue-tables-bulk.dto';
import { CreateVenueStationsBulkDto } from './dto/create-venue-stations-bulk.dto';
import { UpdateVenueTableDto } from './dto/update-venue-table.dto';
import { UpdateVenueStationDto } from './dto/update-venue-station.dto';
import { UpdateVenuePricingDto } from './dto/update-venue-pricing.dto';
import {
  BAR_PRICE_KEYS,
  DEFAULT_BAR_PRICE_LIST,
  DEFAULT_CLOAKROOM_UNIT_PRICE,
  VenueBarPriceKey,
} from './venue-pricing.constants';

type AnalyticsDistributionItem = {
  label: string;
  count: number;
  share?: number;
};

type AnalyticsEventSummary = {
  event_id: string;
  name: string;
  date: string;
  status: string;
  totalRevenue: number;
  entriesRevenue: number;
  barRevenue: number;
  cloakroomRevenue: number;
  tablesRevenue: number;
  totalEntries: number;
  totalReservations: number;
  totalTableGuests: number;
  totalPresences: number;
  avgSpendPerPresence: number;
  averageAge: number | null;
  topEntryHour: string | null;
  women: number;
  men: number;
  other: number;
  unknown: number;
};

type PrNetworkRoleDb = 'responsabile' | 'capo_squadra' | 'pr';
type PrNetworkRoleApi = 'RESPONSABILE' | 'CAPO_SQUADRA' | 'PR';

type PrMembershipRow = {
  id: string;
  venue_id: string;
  user_id: string;
  role: PrNetworkRoleDb;
  parent_membership_id: string | null;
  ref_code: string;
  is_active: boolean;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type PrMemberListRow = PrMembershipRow & {
  user_name: string | null;
  user_username: string | null;
  user_email: string;
  user_role: string;
};

type PrEventAssignmentRow = {
  id: string;
  venue_id: string;
  event_id: string;
  pr_membership_id: string;
  is_active: boolean;
  assigned_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  role: PrNetworkRoleDb;
  ref_code: string;
  parent_membership_id: string | null;
  user_name: string | null;
  user_username: string | null;
  user_email: string;
};

type PrScanRow = {
  id: string;
  venue_id: string;
  event_id: string;
  pr_membership_id: string;
  scanned_by_user_id: string | null;
  guest_user_id: string | null;
  referral_code: string;
  scanned_at: Date;
  entry_id: string | null;
  entered_at: Date | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
};

type PrMembershipVenueRow = {
  membership_id: string;
  venue_id: string;
  venue_name: string;
  venue_city: string | null;
  role: PrNetworkRoleDb;
  parent_membership_id: string | null;
  ref_code: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

@Injectable()
export class VenuesService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly weekdayLabels = [
    'Dom',
    'Lun',
    'Mar',
    'Mer',
    'Gio',
    'Ven',
    'Sab',
  ];

  private decimalToNumber(value: unknown): number {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    const maybeDecimal = value as { toNumber?: () => number };
    if (typeof maybeDecimal?.toNumber === 'function') {
      try {
        const n = maybeDecimal.toNumber();
        return Number.isFinite(n) ? n : 0;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  private normalizeBarPriceList(value: unknown) {
    const incomingList = Array.isArray(value) ? value : [];
    const byKey = new Map<string, number>();

    for (const raw of incomingList) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as { key?: unknown; price?: unknown };
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      if (!key || !BAR_PRICE_KEYS.has(key as VenueBarPriceKey)) continue;
      const price = Number(row.price);
      if (!Number.isFinite(price) || price < 0) continue;
      byKey.set(key, Number(price.toFixed(2)));
    }

    return DEFAULT_BAR_PRICE_LIST.map((item) => ({
      key: item.key,
      label: item.label,
      price: Number((byKey.get(item.key) ?? item.price).toFixed(2)),
    }));
  }

  private normalizeBarPriceListInput(value: unknown) {
    if (!Array.isArray(value)) {
      throw new BadRequestException('bar_price_list must be an array');
    }

    const seenKeys = new Set<string>();
    const list = value.map((raw) => {
      const row = raw as { key?: unknown; label?: unknown; price?: unknown };
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      if (!key || !BAR_PRICE_KEYS.has(key as VenueBarPriceKey)) {
        throw new BadRequestException(`Unsupported bar price key: ${key || 'unknown'}`);
      }
      if (seenKeys.has(key)) {
        throw new BadRequestException(`Duplicate bar price key: ${key}`);
      }
      seenKeys.add(key);

      const price = Number(row.price);
      if (!Number.isFinite(price) || price < 0) {
        throw new BadRequestException(`Invalid price for ${key}`);
      }

      const defaultLabel =
        DEFAULT_BAR_PRICE_LIST.find((item) => item.key === key)?.label ?? key;
      const label =
        typeof row.label === 'string' && row.label.trim().length
          ? row.label.trim()
          : defaultLabel;

      return {
        key,
        label,
        price: Number(price.toFixed(2)),
      };
    });

    if (list.length === 0) {
      throw new BadRequestException('bar_price_list cannot be empty');
    }

    return list;
  }



  private normalizeBottlePriceList(value: unknown) {
    if (!Array.isArray(value)) {
      return [] as Array<{ key: string; label: string; price: number }>;
    }

    const list: Array<{ key: string; label: string; price: number }> = [];
    const seenKeys = new Set<string>();

    for (const raw of value) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as { key?: unknown; label?: unknown; price?: unknown };
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      const label = typeof row.label === 'string' ? row.label.trim() : '';
      const price = Number(row.price);

      if (!key || seenKeys.has(key)) continue;
      if (!label) continue;
      if (!Number.isFinite(price) || price < 0) continue;

      seenKeys.add(key);
      list.push({
        key,
        label,
        price: Number(price.toFixed(2)),
      });
    }

    return list;
  }

  private normalizeBottlePriceListInput(value: unknown) {
    if (!Array.isArray(value)) {
      throw new BadRequestException('bottle_price_list must be an array');
    }

    const list: Array<{ key: string; label: string; price: number }> = [];
    const seenKeys = new Set<string>();

    for (const raw of value) {
      const row = raw as { key?: unknown; label?: unknown; price?: unknown };
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      const label = typeof row.label === 'string' ? row.label.trim() : '';
      const price = Number(row.price);

      if (!key) {
        throw new BadRequestException('Bottle item key is required');
      }
      if (seenKeys.has(key)) {
        throw new BadRequestException(`Duplicate bottle price key: ${key}`);
      }
      if (!label) {
        throw new BadRequestException(`Bottle label is required for ${key}`);
      }
      if (!Number.isFinite(price) || price < 0) {
        throw new BadRequestException(`Invalid bottle price for ${key}`);
      }

      seenKeys.add(key);
      list.push({
        key,
        label,
        price: Number(price.toFixed(2)),
      });
    }

    return list;
  }

  private getStripeClient(): Stripe {
    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) {
      throw new BadRequestException(
        'Stripe not configured: missing STRIPE_SECRET_KEY',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return new Stripe(secret, { apiVersion: '2025-02-24.acacia' });
  }

  private startOfDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  private round(value: number, digits = 1): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  private average(values: number[], digits = 1): number {
    if (!values.length) return 0;
    return this.round(
      values.reduce((acc, value) => acc + value, 0) / values.length,
      digits,
    );
  }

  private calculateAge(
    birthDate?: Date | null,
    referenceDate?: Date | null,
  ): number | null {
    if (!birthDate || Number.isNaN(birthDate.getTime())) return null;
    const ref = referenceDate && !Number.isNaN(referenceDate.getTime())
      ? referenceDate
      : new Date();
    let age = ref.getFullYear() - birthDate.getFullYear();
    const monthDiff = ref.getMonth() - birthDate.getMonth();
    const beforeBirthday =
      monthDiff < 0 ||
      (monthDiff === 0 && ref.getDate() < birthDate.getDate());
    if (beforeBirthday) age -= 1;
    return age >= 0 && age <= 100 ? age : null;
  }

  private ageBucket(age: number | null): string {
    if (age == null) return 'Non disponibile';
    if (age < 21) return '18-20';
    if (age < 25) return '21-24';
    if (age < 30) return '25-29';
    if (age < 35) return '30-34';
    return '35+';
  }
  
  private ageBucketFromStored(value?: AgeBucket | null): string {
    if (!value) return 'Non disponibile';
    if (value === AgeBucket.AGE_18_20) return '18-20';
    if (value === AgeBucket.AGE_21_24) return '21-24';
    if (value === AgeBucket.AGE_25_29) return '25-29';
    if (value === AgeBucket.AGE_30_34) return '30-34';
    if (value === AgeBucket.AGE_35_PLUS) return '35+';
    return 'Non disponibile';
  }
  
  private representativeAgeFromStoredBucket(
    value?: AgeBucket | null,
  ): number | null {
    if (!value) return null;
    if (value === AgeBucket.AGE_18_20) return 19;
    if (value === AgeBucket.AGE_21_24) return 22.5;
    if (value === AgeBucket.AGE_25_29) return 27;
    if (value === AgeBucket.AGE_30_34) return 32;
    if (value === AgeBucket.AGE_35_PLUS) return 37;
    return null;
  }

  private hourLabelFromDate(date?: Date | null): string | null {
    if (!date || Number.isNaN(date.getTime())) return null;
    const hours = String(date.getHours()).padStart(2, '0');
    return `${hours}:00`;
  }

  private averageHourLabel(values: number[]): string | null {
    if (!values.length) return null;
    const avg = this.average(values, 2);
    const hours = Math.floor(avg);
    const minutes = Math.round((avg - hours) * 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  private topCountItem(
    source: Map<string, number>,
  ): { label: string; count: number } | null {
    let bestLabel: string | null = null;
    let bestCount = 0;
    for (const [label, count] of source.entries()) {
      if (count > bestCount) {
        bestLabel = label;
        bestCount = count;
      }
    }
    return bestLabel ? { label: bestLabel, count: bestCount } : null;
  }

  private distributionFromMap(
    source: Map<string, number>,
    total?: number,
  ): AnalyticsDistributionItem[] {
    const resolvedTotal = total ?? Array.from(source.values()).reduce((acc, value) => acc + value, 0);
    return Array.from(source.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({
        label,
        count,
        share: resolvedTotal > 0 ? this.round((count / resolvedTotal) * 100, 1) : 0,
      }));
  }

  private async ensureEventBelongsToVenue(eventId: string, venueId: string) {
    const event = await this.prisma.events.findUnique({
      where: { id: eventId },
      select: { id: true, venue_id: true },
    });
    if (!event) throw new NotFoundException('Event not found');
    if (event.venue_id !== venueId) {
      throw new BadRequestException('eventId does not belong to the venue');
    }
  }

  private stationTypeLabel(type: VenueStationType): string {
    if (type === VenueStationType.entry) return 'Ingresso';
    if (type === VenueStationType.cloakroom) return 'Guardaroba';
    if (type === VenueStationType.bar) return 'Bar';
    return 'Tavoli';
  }

  private normalizeAppRole(role: unknown): 'client' | 'staff' | 'venue' | 'admin' | '' {
    const normalized = String(role ?? '').trim().toLowerCase();
    if (
      normalized === 'client' ||
      normalized === 'staff' ||
      normalized === 'venue' ||
      normalized === 'admin'
    ) {
      return normalized;
    }
    return '';
  }

  private toPrRoleApi(role: PrNetworkRoleDb): PrNetworkRoleApi {
    if (role === 'responsabile') return 'RESPONSABILE';
    if (role === 'capo_squadra') return 'CAPO_SQUADRA';
    return 'PR';
  }

  private toPrRoleDb(role: string): PrNetworkRoleDb {
    const normalized = String(role || '').trim().toLowerCase();
    if (normalized === 'responsabile') return 'responsabile';
    if (normalized === 'capo_squadra') return 'capo_squadra';
    if (normalized === 'pr') return 'pr';
    throw new BadRequestException('Unsupported PR role');
  }

  private canManagePrTeam(role: PrNetworkRoleDb): boolean {
    return role === 'responsabile' || role === 'capo_squadra';
  }

  private canManagerCreatePrRole(
    managerRole: PrNetworkRoleDb,
    targetRole: PrNetworkRoleDb,
  ): boolean {
    if (managerRole === 'responsabile') {
      return targetRole === 'capo_squadra' || targetRole === 'pr';
    }
    if (managerRole === 'capo_squadra') {
      return targetRole === 'pr';
    }
    return false;
  }

  private entryTypeToGender(entryType: 'male' | 'female' | 'free'): Gender {
    if (entryType === 'male') return Gender.M;
    if (entryType === 'female') return Gender.F;
    return Gender.ALTRO;
  }

  private normalizeManualGenderInput(gender?: 'M' | 'F' | 'ALTRO'): Gender | null {
    if (gender === 'M') return Gender.M;
    if (gender === 'F') return Gender.F;
    if (gender === 'ALTRO') return Gender.ALTRO;
    return null;
  }

  private normalizeAgeBucketInput(
    bucket?:
      | 'AGE_18_20'
      | 'AGE_21_24'
      | 'AGE_25_29'
      | 'AGE_30_34'
      | 'AGE_35_PLUS'
      | 'UNKNOWN',
  ): AgeBucket | null {
    if (!bucket) return null;
    if (bucket === 'AGE_18_20') return AgeBucket.AGE_18_20;
    if (bucket === 'AGE_21_24') return AgeBucket.AGE_21_24;
    if (bucket === 'AGE_25_29') return AgeBucket.AGE_25_29;
    if (bucket === 'AGE_30_34') return AgeBucket.AGE_30_34;
    if (bucket === 'AGE_35_PLUS') return AgeBucket.AGE_35_PLUS;
    return AgeBucket.UNKNOWN;
  }

  private sanitizePrRefCode(seed: string): string {
    return seed
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
  }

  private toIsoString(value: Date | string | null | undefined): string {
    if (value instanceof Date) return value.toISOString();
    if (!value) return new Date().toISOString();
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
    return parsed.toISOString();
  }

  private mapPrMember(row: PrMemberListRow) {
    return {
      id: row.id,
      venue_id: row.venue_id,
      user_id: row.user_id,
      role: this.toPrRoleApi(row.role),
      parent_membership_id: row.parent_membership_id,
      ref_code: row.ref_code,
      is_active: Boolean(row.is_active),
      created_by_user_id: row.created_by_user_id,
      created_at: this.toIsoString(row.created_at),
      updated_at: this.toIsoString(row.updated_at),
      user: {
        id: row.user_id,
        name: row.user_name,
        username: row.user_username,
        email: row.user_email,
        role: String(row.user_role || '').toLowerCase(),
      },
      display_name: row.user_name || row.user_username || row.user_email,
    };
  }

  private mapPrEventAssignment(row: PrEventAssignmentRow) {
    return {
      id: row.id,
      venue_id: row.venue_id,
      event_id: row.event_id,
      pr_membership_id: row.pr_membership_id,
      is_active: Boolean(row.is_active),
      assigned_by_user_id: row.assigned_by_user_id,
      created_at: this.toIsoString(row.created_at),
      updated_at: this.toIsoString(row.updated_at),
      membership: {
        id: row.pr_membership_id,
        role: this.toPrRoleApi(row.role),
        ref_code: row.ref_code,
        parent_membership_id: row.parent_membership_id,
        display_name: row.user_name || row.user_username || row.user_email,
        user: {
          name: row.user_name,
          username: row.user_username,
          email: row.user_email,
        },
      },
    };
  }

  private mapPrScan(row: PrScanRow) {
    return {
      id: row.id,
      venue_id: row.venue_id,
      event_id: row.event_id,
      pr_membership_id: row.pr_membership_id,
      scanned_by_user_id: row.scanned_by_user_id,
      guest_user_id: row.guest_user_id,
      referral_code: row.referral_code,
      scanned_at: this.toIsoString(row.scanned_at),
      entry_id: row.entry_id,
      entered_at: row.entered_at ? this.toIsoString(row.entered_at) : null,
      metadata: row.metadata ?? null,
      created_at: this.toIsoString(row.created_at),
      updated_at: this.toIsoString(row.updated_at),
    };
  }

  private async loadPrMemberRows(venueId: string): Promise<PrMemberListRow[]> {
    return this.prisma.$queryRaw<PrMemberListRow[]>(Prisma.sql`
      SELECT
        m.id,
        m.venue_id,
        m.user_id,
        m.role::text AS role,
        m.parent_membership_id,
        m.ref_code,
        m.is_active,
        m.created_by_user_id,
        m.created_at,
        m.updated_at,
        u.name AS user_name,
        u.username AS user_username,
        u.email AS user_email,
        u.role::text AS user_role
      FROM venue_pr_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.venue_id = ${venueId}::uuid
      ORDER BY
        CASE m.role
          WHEN 'responsabile' THEN 0
          WHEN 'capo_squadra' THEN 1
          ELSE 2
        END,
        COALESCE(u.name, u.username, u.email) ASC
    `);
  }

  private async loadPrMemberRowById(
    venueId: string,
    memberId: string,
  ): Promise<PrMemberListRow | null> {
    const rows = await this.prisma.$queryRaw<PrMemberListRow[]>(Prisma.sql`
      SELECT
        m.id,
        m.venue_id,
        m.user_id,
        m.role::text AS role,
        m.parent_membership_id,
        m.ref_code,
        m.is_active,
        m.created_by_user_id,
        m.created_at,
        m.updated_at,
        u.name AS user_name,
        u.username AS user_username,
        u.email AS user_email,
        u.role::text AS user_role
      FROM venue_pr_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.venue_id = ${venueId}::uuid
        AND m.id = ${memberId}::uuid
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private async loadPrMembershipByUser(
    venueId: string,
    userId: string,
  ): Promise<PrMembershipRow | null> {
    const rows = await this.prisma.$queryRaw<PrMembershipRow[]>(Prisma.sql`
      SELECT
        id,
        venue_id,
        user_id,
        role::text AS role,
        parent_membership_id,
        ref_code,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      FROM venue_pr_memberships
      WHERE venue_id = ${venueId}::uuid
        AND user_id = ${userId}::uuid
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private async loadPrMembershipById(
    venueId: string,
    memberId: string,
  ): Promise<PrMembershipRow | null> {
    const rows = await this.prisma.$queryRaw<PrMembershipRow[]>(Prisma.sql`
      SELECT
        id,
        venue_id,
        user_id,
        role::text AS role,
        parent_membership_id,
        ref_code,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      FROM venue_pr_memberships
      WHERE venue_id = ${venueId}::uuid
        AND id = ${memberId}::uuid
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private async loadPrMembershipByRefCode(
    venueId: string,
    refCode: string,
  ): Promise<PrMembershipRow | null> {
    const rows = await this.prisma.$queryRaw<PrMembershipRow[]>(Prisma.sql`
      SELECT
        id,
        venue_id,
        user_id,
        role::text AS role,
        parent_membership_id,
        ref_code,
        is_active,
        created_by_user_id,
        created_at,
        updated_at
      FROM venue_pr_memberships
      WHERE venue_id = ${venueId}::uuid
        AND upper(ref_code) = upper(${refCode})
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private collectPrSubtree(
    rootId: string,
    rows: Array<{ id: string; parent_membership_id: string | null }>,
  ): Set<string> {
    const childrenMap = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parent_membership_id) continue;
      const siblings = childrenMap.get(row.parent_membership_id) ?? [];
      siblings.push(row.id);
      childrenMap.set(row.parent_membership_id, siblings);
    }

    const visited = new Set<string>();
    const queue: string[] = [rootId];

    while (queue.length) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);

      const children = childrenMap.get(current) ?? [];
      for (const child of children) {
        if (!visited.has(child)) queue.push(child);
      }
    }

    return visited;
  }

  private validatePrHierarchy(
    role: PrNetworkRoleDb,
    parent: PrMembershipRow | null,
  ) {
    if (role === 'responsabile') {
      if (parent) {
        throw new BadRequestException('Il ruolo RESPONSABILE non puo avere un superiore');
      }
      return;
    }

    if (!parent) {
      throw new BadRequestException('Questo ruolo richiede un superiore');
    }

    if (role === 'capo_squadra' && parent.role !== 'responsabile') {
      throw new BadRequestException('CAPO_SQUADRA deve avere un RESPONSABILE sopra di lui');
    }

    if (role === 'pr' && parent.role === 'pr') {
      throw new BadRequestException('PR deve essere assegnato sotto un RESPONSABILE o CAPO_SQUADRA');
    }
  }

  private async buildUniquePrRefCode(
    venueId: string,
    seed: string,
    excludeMemberId?: string,
  ): Promise<string> {
    const base = this.sanitizePrRefCode(seed) || 'PR';
    let candidate = base;
    let index = 1;

    while (index < 200) {
      const rows = excludeMemberId
        ? await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT id
            FROM venue_pr_memberships
            WHERE venue_id = ${venueId}::uuid
              AND upper(ref_code) = upper(${candidate})
              AND id <> ${excludeMemberId}::uuid
            LIMIT 1
          `)
        : await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT id
            FROM venue_pr_memberships
            WHERE venue_id = ${venueId}::uuid
              AND upper(ref_code) = upper(${candidate})
            LIMIT 1
          `);

      if (!rows.length) return candidate;
      candidate = `${base}-${index}`;
      index += 1;
    }

    throw new BadRequestException('Impossibile generare un ref_code univoco');
  }

  private async resolvePrActorContext(
    venueId: string,
    user?: RequestUser,
    requireManagePermission = false,
  ): Promise<{ owner: boolean; membership: PrMembershipRow | null }> {
    if (!user?.id) throw new ForbiddenException('Forbidden');

    const appRole = this.normalizeAppRole(user.role);
    if (appRole === 'admin') {
      return { owner: true, membership: null };
    }

    if (appRole === 'venue') {
      if (!user.venue_id || user.venue_id !== venueId) {
        throw new ForbiddenException('Forbidden');
      }
      return { owner: true, membership: null };
    }

    const membership = await this.loadPrMembershipByUser(venueId, user.id);
    if (!membership || !membership.is_active) {
      throw new ForbiddenException('Forbidden');
    }

    if (requireManagePermission && !this.canManagePrTeam(membership.role)) {
      throw new ForbiddenException('Forbidden');
    }

    return { owner: false, membership };
  }

  async listVenues(): Promise<venues[]> {
    return await this.prisma.venues.findMany({
      orderBy: { created_at: 'desc' },
    });
  }

  async getVenue(id: string): Promise<venues> {
    const v = await this.prisma.venues.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Venue not found');
    return v;
  }

  async getVenuePricing(id: string): Promise<{
    venue_id: string;
    cloakroom_unit_price: number;
    bar_price_list: Array<{ key: string; label: string; price: number }>;
    bottle_price_list: Array<{ key: string; label: string; price: number }>;
  }> {
    const venue = await this.prisma.venues.findUnique({
      where: { id },
      select: {
        id: true,
        cloakroom_unit_price: true,
        bar_price_list: true,
        bottle_price_list: true,
      },
    });

    if (!venue) throw new NotFoundException('Venue not found');

    const cloakroom = this.decimalToNumber(venue.cloakroom_unit_price);
    return {
      venue_id: id,
      cloakroom_unit_price: Number(
        (cloakroom > 0 ? cloakroom : DEFAULT_CLOAKROOM_UNIT_PRICE).toFixed(2),
      ),
      bar_price_list: this.normalizeBarPriceList(venue.bar_price_list),
      bottle_price_list: this.normalizeBottlePriceList(venue.bottle_price_list),
    };
  }

  async updateVenuePricing(
    id: string,
    updates: UpdateVenuePricingDto,
  ): Promise<{
    venue_id: string;
    cloakroom_unit_price: number;
    bar_price_list: Array<{ key: string; label: string; price: number }>;
    bottle_price_list: Array<{ key: string; label: string; price: number }>;
  }> {
    await this.getVenue(id);

    const data: Prisma.venuesUpdateInput = {};

    if (updates.cloakroom_unit_price !== undefined) {
      const price = Number(updates.cloakroom_unit_price);
      if (!Number.isFinite(price) || price < 0) {
        throw new BadRequestException('cloakroom_unit_price must be >= 0');
      }
      data.cloakroom_unit_price = Number(price.toFixed(2));
    }

    if (updates.bar_price_list !== undefined) {
      const normalized = this.normalizeBarPriceListInput(updates.bar_price_list);
      data.bar_price_list = normalized as Prisma.InputJsonValue;
    }

    if (updates.bottle_price_list !== undefined) {
      const normalized = this.normalizeBottlePriceListInput(updates.bottle_price_list);
      data.bottle_price_list = normalized as Prisma.InputJsonValue;
    }

    if (Object.keys(data).length === 0) {
      return this.getVenuePricing(id);
    }

    const updated = await this.prisma.venues.update({
      where: { id },
      data,
      select: {
        id: true,
        cloakroom_unit_price: true,
        bar_price_list: true,
        bottle_price_list: true,
      },
    });

    return {
      venue_id: updated.id,
      cloakroom_unit_price: Number(
        this.decimalToNumber(updated.cloakroom_unit_price).toFixed(2),
      ),
      bar_price_list: this.normalizeBarPriceList(updated.bar_price_list),
      bottle_price_list: this.normalizeBottlePriceList(updated.bottle_price_list),
    };
  }

  async createVenue(input: {
    name: string;
    city?: string;
    radius_geofence?: number;
    stripe_account_id?: string;
  }): Promise<venues> {
    if (!input || !input.name) {
      throw new BadRequestException('Missing required fields');
    }

    const data: Prisma.venuesCreateInput = {
      name: input.name,
      city: input.city ?? undefined,
    };

    if (input.radius_geofence !== undefined) {
      data.radius_geofence = input.radius_geofence;
    }
    if (input.stripe_account_id !== undefined) {
      data.stripe_account_id = input.stripe_account_id;
    }

    return await this.prisma.venues.create({ data });
  }

  async updateVenue(
    id: string,
    updates: Partial<{
      name?: string;
      city?: string;
      radius_geofence?: number;
      stripe_account_id?: string;
    }>,
  ): Promise<venues> {
    await this.getVenue(id);

    const data: Prisma.venuesUpdateInput = {};
    if (updates.name !== undefined) data.name = updates.name;
    if (updates.city !== undefined) data.city = updates.city;
    if (updates.radius_geofence !== undefined) {
      data.radius_geofence = updates.radius_geofence;
    }
    if (updates.stripe_account_id !== undefined) {
      data.stripe_account_id = updates.stripe_account_id;
    }

    return await this.prisma.venues.update({ where: { id }, data });
  }

  async deleteVenue(id: string): Promise<venues> {
    await this.getVenue(id);
    return await this.prisma.venues.delete({ where: { id } });
  }

  async listEvents(venueId: string): Promise<events[]> {
    return await this.prisma.events.findMany({
      where: { venue_id: venueId },
      orderBy: { date: 'desc' },
    });
  }

  async createStripeConnectOnboardingLink(params: {
    venueId: string;
    refreshUrl?: string;
    returnUrl?: string;
    email?: string;
  }) {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    const venue = await this.prisma.venues.findUnique({
      where: { id: params.venueId },
      select: {
        id: true,
        name: true,
        stripe_account_id: true,
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    const stripe = this.getStripeClient();

    let stripeAccountId = venue.stripe_account_id;
    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'IT',
        email: params.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: venue.name,
        },
      });
      stripeAccountId = account.id;

      await this.prisma.venues.update({
        where: { id: params.venueId },
        data: { stripe_account_id: stripeAccountId },
      });
    }

    const fallbackBase =
      process.env.STRIPE_CONNECT_RETURN_URL || 'https://example.com/stripe';
    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      type: 'account_onboarding',
      refresh_url:
        params.refreshUrl ||
        `${fallbackBase}?refresh=1&venue_id=${params.venueId}`,
      return_url:
        params.returnUrl ||
        `${fallbackBase}?success=1&venue_id=${params.venueId}`,
    });

    return {
      venue_id: params.venueId,
      stripe_account_id: stripeAccountId,
      onboarding_url: accountLink.url,
      expires_at: accountLink.expires_at,
    };
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
  }

  async getStripeConnectStatus(venueId: string) {
    /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: {
        id: true,
        stripe_account_id: true,
        stripe_charges_enabled: true,
        stripe_payouts_enabled: true,
        stripe_onboarding_completed_at: true,
      },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    if (!venue.stripe_account_id) {
      return {
        venue_id: venueId,
        connected: false,
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
      };
    }

    const stripe = this.getStripeClient();
    const account = await stripe.accounts.retrieve(venue.stripe_account_id);

    const chargesEnabled = Boolean(account.charges_enabled);
    const payoutsEnabled = Boolean(account.payouts_enabled);
    const detailsSubmitted = Boolean(account.details_submitted);

    await this.prisma.venues.update({
      where: { id: venueId },
      data: {
        stripe_charges_enabled: chargesEnabled,
        stripe_payouts_enabled: payoutsEnabled,
        stripe_onboarding_completed_at:
          chargesEnabled && payoutsEnabled ? new Date() : null,
      },
    });

    return {
      venue_id: venueId,
      connected: true,
      stripe_account_id: venue.stripe_account_id,
      charges_enabled: chargesEnabled,
      payouts_enabled: payoutsEnabled,
      details_submitted: detailsSubmitted,
      requirements_due: account.requirements?.currently_due ?? [],
    };
    /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
  }

  async listPromos(venueId: string): Promise<promos[]> {
    return await this.prisma.promos.findMany({
      where: { venue_id: venueId },
      orderBy: { created_at: 'desc' },
    });
  }

  async listVenueTables(venueId: string): Promise<venue_tables[]> {
    // Ensure venue exists
    await this.getVenue(venueId);

    return await this.prisma.venue_tables.findMany({
      where: { venue_id: venueId },
      orderBy: [{ zona: 'asc' }, { nome: 'asc' }],
    });
  }

  async listVenueStations(venueId: string): Promise<venue_stations[]> {
    await this.getVenue(venueId);

    return this.prisma.venue_stations.findMany({
      where: { venue_id: venueId },
      orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
    });
  }

  async listAssignableUsersForPr(
    venueId: string,
    searchRaw: string | undefined,
    user?: RequestUser,
  ) {
    await this.getVenue(venueId);
    await this.resolvePrActorContext(venueId, user, true);

    const search = String(searchRaw ?? '').trim();
    const normalizedSearch = search.slice(0, 80);
    const pattern = `%${normalizedSearch}%`;
    const limit = normalizedSearch.length >= 2 ? 30 : 100;

    type AssignableUserRow = {
      id: string;
      name: string | null;
      username: string | null;
      email: string;
      role: string;
      venue_id: string | null;
      is_associated_to_venue: boolean;
      already_assigned: boolean;
    };

    const rows = normalizedSearch.length >= 2
      ? await this.prisma.$queryRaw<AssignableUserRow[]>(Prisma.sql`
          SELECT
            u.id,
            u.name,
            u.username,
            u.email,
            u.role::text AS role,
            u.venue_id,
            CASE WHEN u.venue_id = ${venueId}::uuid THEN true ELSE false END AS is_associated_to_venue,
            CASE WHEN m.id IS NULL THEN false ELSE true END AS already_assigned
          FROM users u
          LEFT JOIN venue_pr_memberships m
            ON m.venue_id = ${venueId}::uuid
           AND m.user_id = u.id
          WHERE u.role <> 'admin'::"UserRole"
            AND (
              u.venue_id = ${venueId}::uuid
              OR COALESCE(u.name, '') ILIKE ${pattern}
              OR COALESCE(u.username, '') ILIKE ${pattern}
              OR COALESCE(u.email, '') ILIKE ${pattern}
            )
          ORDER BY
            CASE WHEN u.venue_id = ${venueId}::uuid THEN 0 ELSE 1 END,
            CASE WHEN m.id IS NULL THEN 0 ELSE 1 END,
            COALESCE(u.last_active_at, u.updated_at, u.created_at) DESC
          LIMIT ${limit}
        `)
      : await this.prisma.$queryRaw<AssignableUserRow[]>(Prisma.sql`
          SELECT
            u.id,
            u.name,
            u.username,
            u.email,
            u.role::text AS role,
            u.venue_id,
            true AS is_associated_to_venue,
            CASE WHEN m.id IS NULL THEN false ELSE true END AS already_assigned
          FROM users u
          LEFT JOIN venue_pr_memberships m
            ON m.venue_id = ${venueId}::uuid
           AND m.user_id = u.id
          WHERE u.role <> 'admin'::"UserRole"
            AND u.venue_id = ${venueId}::uuid
          ORDER BY
            CASE WHEN m.id IS NULL THEN 0 ELSE 1 END,
            COALESCE(u.last_active_at, u.updated_at, u.created_at) DESC
          LIMIT ${limit}
        `);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      username: row.username,
      email: row.email,
      role: String(row.role || '').toLowerCase(),
      venue_id: row.venue_id,
      is_associated_to_venue: Boolean(row.is_associated_to_venue),
      already_assigned: Boolean(row.already_assigned),
      display_name: row.name || row.username || row.email,
    }));
  }

  async getMyPrNetworkMembership(venueId: string, user?: RequestUser) {
    await this.getVenue(venueId);
    if (!user?.id) throw new ForbiddenException('Forbidden');

    const appRole = this.normalizeAppRole(user.role);
    if (appRole === 'venue' && (!user.venue_id || user.venue_id !== venueId)) {
      throw new ForbiddenException('Forbidden');
    }

    const membership = await this.loadPrMembershipByUser(venueId, user.id);
    const isOwner = appRole === 'admin' || (appRole === 'venue' && user.venue_id === venueId);

    return {
      venue_id: venueId,
      can_access_dashboard: isOwner || Boolean(membership?.is_active),
      can_manage_team:
        isOwner ||
        Boolean(membership?.is_active && this.canManagePrTeam(membership.role)),
      membership: membership
        ? {
            id: membership.id,
            user_id: membership.user_id,
            role: this.toPrRoleApi(membership.role),
            parent_membership_id: membership.parent_membership_id,
            ref_code: membership.ref_code,
            is_active: Boolean(membership.is_active),
            created_at: this.toIsoString(membership.created_at),
            updated_at: this.toIsoString(membership.updated_at),
          }
        : null,
    };
  }

  async listVenuePrNetworkMembers(venueId: string, user?: RequestUser) {
    await this.getVenue(venueId);
    const actorContext = await this.resolvePrActorContext(venueId, user, false);

    const rows = await this.loadPrMemberRows(venueId);
    const visibleRows = !actorContext.owner && actorContext.membership
      ? (() => {
          const allowed = this.collectPrSubtree(actorContext.membership.id, rows);
          return rows.filter((row) => allowed.has(row.id));
        })()
      : rows;

    return visibleRows.map((row) => this.mapPrMember(row));
  }

  async createVenuePrNetworkMember(
    venueId: string,
    payload: {
      user_id: string;
      role: string;
      parent_membership_id?: string | null;
      ref_code?: string | null;
    },
    user?: RequestUser,
  ) {
    await this.getVenue(venueId);

    if (!payload?.user_id) {
      throw new BadRequestException('user_id is required');
    }

    const actorContext = await this.resolvePrActorContext(venueId, user, true);
    const targetRole = this.toPrRoleDb(payload.role);

    const targetUser = await this.prisma.users.findUnique({
      where: { id: payload.user_id },
      select: {
        id: true,
        email: true,
        username: true,
        name: true,
      },
    });
    if (!targetUser) throw new NotFoundException('User not found');

    const existingMembership = await this.loadPrMembershipByUser(venueId, payload.user_id);
    if (existingMembership) {
      throw new BadRequestException('User already assigned to this venue PR network');
    }

    let resolvedParentId: string | null = payload.parent_membership_id ?? null;

    if (!actorContext.owner) {
      const actorMembership = actorContext.membership;
      if (!actorMembership) throw new ForbiddenException('Forbidden');

      if (!this.canManagerCreatePrRole(actorMembership.role, targetRole)) {
        throw new ForbiddenException('Forbidden');
      }

      if (resolvedParentId && resolvedParentId !== actorMembership.id) {
        throw new ForbiddenException('Puoi assegnare solo membri nel tuo team diretto');
      }

      resolvedParentId = actorMembership.id;
    }

    const parent = resolvedParentId
      ? await this.loadPrMembershipById(venueId, resolvedParentId)
      : null;

    if (resolvedParentId && !parent) {
      throw new BadRequestException('Parent membership not found');
    }

    this.validatePrHierarchy(targetRole, parent);

    const refSeed =
      payload.ref_code?.trim() ||
      targetUser.username ||
      targetUser.name ||
      targetUser.email;
    const refCode = await this.buildUniquePrRefCode(venueId, refSeed);

    const inserted = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO venue_pr_memberships (
        venue_id,
        user_id,
        role,
        parent_membership_id,
        ref_code,
        is_active,
        created_by_user_id,
        updated_at
      )
      VALUES (
        ${venueId}::uuid,
        ${payload.user_id}::uuid,
        ${targetRole}::"VenuePrRole",
        ${resolvedParentId}::uuid,
        ${refCode},
        true,
        ${user?.id ?? null}::uuid,
        NOW()
      )
      RETURNING id
    `);

    const createdId = inserted[0]?.id;
    if (!createdId) {
      throw new BadRequestException('Unable to create PR membership');
    }

    const row = await this.loadPrMemberRowById(venueId, createdId);
    if (!row) throw new NotFoundException('Created PR membership not found');

    return this.mapPrMember(row);
  }

  async updateVenuePrNetworkMember(
    venueId: string,
    memberId: string,
    payload: {
      role?: string;
      parent_membership_id?: string | null;
      is_active?: boolean;
      ref_code?: string;
    },
    user?: RequestUser,
  ) {
    await this.getVenue(venueId);

    const existing = await this.loadPrMembershipById(venueId, memberId);
    if (!existing) throw new NotFoundException('PR membership not found');

    const actorContext = await this.resolvePrActorContext(venueId, user, true);

    if (!actorContext.owner) {
      const actorMembership = actorContext.membership;
      if (!actorMembership) throw new ForbiddenException('Forbidden');

      if (existing.parent_membership_id !== actorMembership.id || existing.role !== 'pr') {
        throw new ForbiddenException('Puoi gestire solo PR diretti del tuo team');
      }

      const onlyToggleActive =
        payload.is_active !== undefined &&
        payload.role === undefined &&
        payload.parent_membership_id === undefined &&
        payload.ref_code === undefined;

      if (!onlyToggleActive) {
        throw new ForbiddenException('Non hai permessi per modificare questi campi');
      }
    }

    let nextRole = existing.role;
    let nextParentId = existing.parent_membership_id;
    let nextIsActive = Boolean(existing.is_active);
    let nextRefCode = existing.ref_code;

    if (actorContext.owner) {
      if (payload.role !== undefined) {
        nextRole = this.toPrRoleDb(payload.role);
      }

      if (payload.parent_membership_id !== undefined) {
        nextParentId = payload.parent_membership_id ?? null;
      }

      if (payload.ref_code !== undefined) {
        nextRefCode = await this.buildUniquePrRefCode(
          venueId,
          payload.ref_code || existing.ref_code,
          existing.id,
        );
      }
    }

    if (payload.is_active !== undefined) {
      nextIsActive = Boolean(payload.is_active);
    }

    if (nextParentId && nextParentId === existing.id) {
      throw new BadRequestException('Un membro non puo essere il proprio superiore');
    }

    const parent = nextParentId
      ? await this.loadPrMembershipById(venueId, nextParentId)
      : null;

    if (nextParentId && !parent) {
      throw new BadRequestException('Parent membership not found');
    }

    if (actorContext.owner && nextParentId) {
      const treeRows = await this.prisma.$queryRaw<
        Array<{ id: string; parent_membership_id: string | null }>
      >(Prisma.sql`
        SELECT id, parent_membership_id
        FROM venue_pr_memberships
        WHERE venue_id = ${venueId}::uuid
      `);
      const selfAndDescendants = this.collectPrSubtree(existing.id, treeRows);
      if (selfAndDescendants.has(nextParentId)) {
        throw new BadRequestException('Ciclo gerarchico non consentito');
      }
    }

    this.validatePrHierarchy(nextRole, parent);

    const updates: Prisma.Sql[] = [];

    if (nextRole !== existing.role) {
      updates.push(Prisma.sql`role = ${nextRole}::"VenuePrRole"`);
    }

    if ((nextParentId ?? null) !== (existing.parent_membership_id ?? null)) {
      updates.push(Prisma.sql`parent_membership_id = ${nextParentId}::uuid`);
    }

    if (nextRefCode !== existing.ref_code) {
      updates.push(Prisma.sql`ref_code = ${nextRefCode}`);
    }

    if (nextIsActive !== Boolean(existing.is_active)) {
      updates.push(Prisma.sql`is_active = ${nextIsActive}`);
    }

    if (!updates.length) {
      const row = await this.loadPrMemberRowById(venueId, memberId);
      if (!row) throw new NotFoundException('PR membership not found');
      return this.mapPrMember(row);
    }

    updates.push(Prisma.sql`updated_at = NOW()`);

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE venue_pr_memberships
      SET ${Prisma.join(updates, ', ')}
      WHERE venue_id = ${venueId}::uuid
        AND id = ${memberId}::uuid
    `);

    const row = await this.loadPrMemberRowById(venueId, memberId);
    if (!row) throw new NotFoundException('PR membership not found');

    return this.mapPrMember(row);
  }

  async deleteVenuePrNetworkMember(
    venueId: string,
    memberId: string,
    user?: RequestUser,
  ) {
    await this.getVenue(venueId);

    const existing = await this.loadPrMembershipById(venueId, memberId);
    if (!existing) throw new NotFoundException('PR membership not found');

    const actorContext = await this.resolvePrActorContext(venueId, user, true);
    if (!actorContext.owner) {
      const actorMembership = actorContext.membership;
      if (!actorMembership) throw new ForbiddenException('Forbidden');

      if (existing.parent_membership_id !== actorMembership.id || existing.role !== 'pr') {
        throw new ForbiddenException('Puoi eliminare solo PR diretti del tuo team');
      }
    }

    const children = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id
      FROM venue_pr_memberships
      WHERE venue_id = ${venueId}::uuid
        AND parent_membership_id = ${memberId}::uuid
      LIMIT 1
    `);

    if (children.length > 0) {
      throw new BadRequestException(
        'Impossibile eliminare: riassegna prima i membri del team collegati',
      );
    }

    await this.prisma.$executeRaw(Prisma.sql`
      DELETE FROM venue_pr_memberships
      WHERE venue_id = ${venueId}::uuid
        AND id = ${memberId}::uuid
    `);

    return { deleted: true, id: memberId };
  }

  async listMyPrVenueMemberships(user?: RequestUser) {
    if (!user?.id) throw new ForbiddenException('Forbidden');

    const rows = await this.prisma.$queryRaw<PrMembershipVenueRow[]>(Prisma.sql`
      SELECT
        m.id AS membership_id,
        m.venue_id,
        v.name AS venue_name,
        v.city AS venue_city,
        m.role::text AS role,
        m.parent_membership_id,
        m.ref_code,
        m.is_active,
        m.created_at,
        m.updated_at
      FROM venue_pr_memberships m
      JOIN venues v ON v.id = m.venue_id
      WHERE m.user_id = ${user.id}::uuid
        AND m.is_active = true
      ORDER BY m.updated_at DESC
    `);

    return rows.map((row) => ({
      membership_id: row.membership_id,
      venue_id: row.venue_id,
      venue_name: row.venue_name,
      venue_city: row.venue_city,
      role: this.toPrRoleApi(row.role),
      parent_membership_id: row.parent_membership_id,
      ref_code: row.ref_code,
      is_active: Boolean(row.is_active),
      can_manage_team: this.canManagePrTeam(row.role),
      created_at: this.toIsoString(row.created_at),
      updated_at: this.toIsoString(row.updated_at),
    }));
  }

  async assignPrMemberToEvent(
    venueId: string,
    payload: {
      event_id: string;
      pr_membership_id: string;
      is_active?: boolean;
    },
    user?: RequestUser,
  ) {
    await this.getVenue(venueId);
    await this.ensureEventBelongsToVenue(payload.event_id, venueId);

    const actorContext = await this.resolvePrActorContext(venueId, user, true);
    const membership = await this.loadPrMembershipById(
      venueId,
      payload.pr_membership_id,
    );
    if (!membership) {
      throw new NotFoundException('PR membership not found');
    }
    if (!membership.is_active) {
      throw new BadRequestException('PR membership is not active');
    }

    if (!actorContext.owner && actorContext.membership) {
      const treeRows = await this.prisma.$queryRaw<
        Array<{ id: string; parent_membership_id: string | null }>
      >(Prisma.sql`
        SELECT id, parent_membership_id
        FROM venue_pr_memberships
        WHERE venue_id = ${venueId}::uuid
      `);
      const allowed = this.collectPrSubtree(actorContext.membership.id, treeRows);
      if (!allowed.has(membership.id)) {
        throw new ForbiddenException('Forbidden');
      }
    }

    const nextActive = payload.is_active ?? true;

    await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO venue_pr_event_assignments (
        venue_id,
        event_id,
        pr_membership_id,
        is_active,
        assigned_by_user_id,
        updated_at
      )
      VALUES (
        ${venueId}::uuid,
        ${payload.event_id}::uuid,
        ${payload.pr_membership_id}::uuid,
        ${nextActive},
        ${user?.id ?? null}::uuid,
        NOW()
      )
      ON CONFLICT (event_id, pr_membership_id)
      DO UPDATE
      SET
        is_active = EXCLUDED.is_active,
        assigned_by_user_id = EXCLUDED.assigned_by_user_id,
        updated_at = NOW()
    `);

    const rows = await this.prisma.$queryRaw<PrEventAssignmentRow[]>(Prisma.sql`
      SELECT
        a.id,
        a.venue_id,
        a.event_id,
        a.pr_membership_id,
        a.is_active,
        a.assigned_by_user_id,
        a.created_at,
        a.updated_at,
        m.role::text AS role,
        m.ref_code,
        m.parent_membership_id,
        u.name AS user_name,
        u.username AS user_username,
        u.email AS user_email
      FROM venue_pr_event_assignments a
      JOIN venue_pr_memberships m ON m.id = a.pr_membership_id
      JOIN users u ON u.id = m.user_id
      WHERE a.venue_id = ${venueId}::uuid
        AND a.event_id = ${payload.event_id}::uuid
        AND a.pr_membership_id = ${payload.pr_membership_id}::uuid
      LIMIT 1
    `);

    const row = rows[0];
    if (!row) throw new NotFoundException('PR event assignment not found');
    return this.mapPrEventAssignment(row);
  }

  async listPrEventAssignments(
    venueId: string,
    eventId: string,
    user?: RequestUser,
  ) {
    await this.getVenue(venueId);
    await this.ensureEventBelongsToVenue(eventId, venueId);

    const actorContext = await this.resolvePrActorContext(venueId, user, false);
    const rows = await this.prisma.$queryRaw<PrEventAssignmentRow[]>(Prisma.sql`
      SELECT
        a.id,
        a.venue_id,
        a.event_id,
        a.pr_membership_id,
        a.is_active,
        a.assigned_by_user_id,
        a.created_at,
        a.updated_at,
        m.role::text AS role,
        m.ref_code,
        m.parent_membership_id,
        u.name AS user_name,
        u.username AS user_username,
        u.email AS user_email
      FROM venue_pr_event_assignments a
      JOIN venue_pr_memberships m ON m.id = a.pr_membership_id
      JOIN users u ON u.id = m.user_id
      WHERE a.venue_id = ${venueId}::uuid
        AND a.event_id = ${eventId}::uuid
      ORDER BY
        CASE m.role
          WHEN 'responsabile' THEN 0
          WHEN 'capo_squadra' THEN 1
          ELSE 2
        END,
        COALESCE(u.name, u.username, u.email) ASC
    `);

    if (actorContext.owner) {
      return rows.map((row) => this.mapPrEventAssignment(row));
    }

    const actorMembership = actorContext.membership;
    if (!actorMembership) return [];

    const allMembers = await this.loadPrMemberRows(venueId);
    const allowed = this.collectPrSubtree(actorMembership.id, allMembers);
    return rows
      .filter((row) => allowed.has(row.pr_membership_id))
      .map((row) => this.mapPrEventAssignment(row));
  }

  async registerPrQrScan(
    venueId: string,
    payload: {
      event_id: string;
      pr_membership_id?: string;
      ref_code?: string;
      guest_user_id?: string;
      metadata?: Record<string, unknown>;
    },
    user?: RequestUser,
  ) {
    await this.getVenue(venueId);
    await this.ensureEventBelongsToVenue(payload.event_id, venueId);

    const actorContext = await this.resolvePrActorContext(venueId, user, false);

    let targetMembership: PrMembershipRow | null = null;
    if (payload.pr_membership_id) {
      targetMembership = await this.loadPrMembershipById(
        venueId,
        payload.pr_membership_id,
      );
    } else if (payload.ref_code?.trim()) {
      targetMembership = await this.loadPrMembershipByRefCode(
        venueId,
        payload.ref_code.trim(),
      );
    } else if (actorContext.membership) {
      targetMembership = actorContext.membership;
    }

    if (!targetMembership) {
      throw new BadRequestException('pr_membership_id or ref_code is required');
    }
    if (!targetMembership.is_active) {
      throw new BadRequestException('PR membership is not active');
    }

    if (!actorContext.owner && actorContext.membership) {
      const allMembers = await this.loadPrMemberRows(venueId);
      const allowed = this.collectPrSubtree(actorContext.membership.id, allMembers);
      if (!allowed.has(targetMembership.id)) {
        throw new ForbiddenException('Forbidden');
      }
    }

    const assignmentRows = await this.prisma.$queryRaw<Array<{ is_active: boolean }>>(
      Prisma.sql`
        SELECT is_active
        FROM venue_pr_event_assignments
        WHERE venue_id = ${venueId}::uuid
          AND event_id = ${payload.event_id}::uuid
          AND pr_membership_id = ${targetMembership.id}::uuid
        LIMIT 1
      `,
    );

    if (!assignmentRows[0]) {
      throw new BadRequestException('PR is not assigned to this event');
    }

    if (!assignmentRows[0].is_active) {
      throw new BadRequestException('PR is not active for this event');
    }

    const metadataJson = payload.metadata ? JSON.stringify(payload.metadata) : null;
    const rows = await this.prisma.$queryRaw<PrScanRow[]>(Prisma.sql`
      INSERT INTO venue_pr_qr_scans (
        venue_id,
        event_id,
        pr_membership_id,
        scanned_by_user_id,
        guest_user_id,
        referral_code,
        metadata,
        updated_at
      )
      VALUES (
        ${venueId}::uuid,
        ${payload.event_id}::uuid,
        ${targetMembership.id}::uuid,
        ${user?.id ?? null}::uuid,
        ${payload.guest_user_id ?? null}::uuid,
        ${targetMembership.ref_code},
        ${metadataJson}::jsonb,
        NOW()
      )
      RETURNING
        id,
        venue_id,
        event_id,
        pr_membership_id,
        scanned_by_user_id,
        guest_user_id,
        referral_code,
        scanned_at,
        entry_id,
        entered_at,
        metadata,
        created_at,
        updated_at
    `);

    const scan = rows[0];
    if (!scan) throw new BadRequestException('Unable to register PR scan');
    return this.mapPrScan(scan);
  }

  async registerPrEntryFromScan(
    venueId: string,
    scanId: string,
    payload: {
      guest_user_id?: string;
      station_id?: string;
      entry_type?: 'male' | 'female' | 'free';
      gender?: 'M' | 'F' | 'ALTRO';
      is_complimentary?: boolean;
      age_bucket?:
        | 'AGE_18_20'
        | 'AGE_21_24'
        | 'AGE_25_29'
        | 'AGE_30_34'
        | 'AGE_35_PLUS'
        | 'UNKNOWN';
    },
    user?: RequestUser,
  ) {
    await this.getVenue(venueId);
    const actorContext = await this.resolvePrActorContext(venueId, user, false);

    const scanRows = await this.prisma.$queryRaw<PrScanRow[]>(Prisma.sql`
      SELECT
        id,
        venue_id,
        event_id,
        pr_membership_id,
        scanned_by_user_id,
        guest_user_id,
        referral_code,
        scanned_at,
        entry_id,
        entered_at,
        metadata,
        created_at,
        updated_at
      FROM venue_pr_qr_scans
      WHERE venue_id = ${venueId}::uuid
        AND id = ${scanId}::uuid
      LIMIT 1
    `);

    const scan = scanRows[0];
    if (!scan) throw new NotFoundException('PR scan not found');

    if (!actorContext.owner && actorContext.membership) {
      const allMembers = await this.loadPrMemberRows(venueId);
      const allowed = this.collectPrSubtree(actorContext.membership.id, allMembers);
      if (!allowed.has(scan.pr_membership_id)) {
        throw new ForbiddenException('Forbidden');
      }
    }

    if (scan.entry_id) {
      const existingEntry = await this.prisma.entries.findUnique({
        where: { id: scan.entry_id },
        select: {
          id: true,
          event_id: true,
          user_id: true,
          staff_id: true,
          station_id: true,
          pr_membership_id: true,
          method: true,
          sesso: true,
          price: true,
          created_at: true,
        },
      });

      return {
        already_registered: true,
        scan: this.mapPrScan(scan),
        entry: existingEntry
          ? {
              ...existingEntry,
              price: this.decimalToNumber(existingEntry.price),
              created_at: this.toIsoString(existingEntry.created_at),
            }
          : null,
      };
    }

    const entryType = payload.entry_type;
    const explicitGender = this.normalizeManualGenderInput(payload.gender);
    const gender = explicitGender ??
      (entryType ? this.entryTypeToGender(entryType) : Gender.ALTRO);
    const isComplimentary =
      payload.is_complimentary ?? (entryType ? entryType === 'free' : false);
    const ageBucket = this.normalizeAgeBucketInput(payload.age_bucket);

    let resolvedStationId: string | null = null;
    if (payload.station_id) {
      const station = await this.prisma.venue_stations.findUnique({
        where: { id: payload.station_id },
        select: {
          id: true,
          venue_id: true,
          station_type: true,
          is_active: true,
        },
      });
      if (!station) throw new NotFoundException('Station not found');
      if (station.venue_id !== venueId) {
        throw new BadRequestException('station_id does not belong to venue');
      }
      if (station.station_type !== VenueStationType.entry) {
        throw new BadRequestException('station_id must be an entry station');
      }
      if (!station.is_active) {
        throw new BadRequestException('station_id is not active');
      }
      resolvedStationId = station.id;
    } else {
      const fallbackStation = await this.prisma.venue_stations.findFirst({
        where: {
          venue_id: venueId,
          station_type: VenueStationType.entry,
          is_active: true,
        },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        select: { id: true },
      });
      resolvedStationId = fallbackStation?.id ?? null;
    }

    const guestUserId = payload.guest_user_id ?? scan.guest_user_id ?? null;
    const entryPrice = await resolveEntryUnitPrice({
      prisma: this.prisma,
      eventId: scan.event_id,
      gender,
      isComplimentary,
    });

    const createdEntry = await this.prisma.entries.create({
      data: {
        event_id: scan.event_id,
        user_id: guestUserId,
        staff_id: user?.id ?? null,
        station_id: resolvedStationId,
        pr_membership_id: scan.pr_membership_id,
        sesso: gender,
        price: entryPrice,
        is_complimentary: isComplimentary,
        age_bucket: ageBucket,
        method: EntryMethod.QR,
      },
      select: {
        id: true,
        event_id: true,
        user_id: true,
        staff_id: true,
        station_id: true,
        pr_membership_id: true,
        method: true,
        sesso: true,
        price: true,
        created_at: true,
      },
    });

    const updatedRows = await this.prisma.$queryRaw<PrScanRow[]>(Prisma.sql`
      UPDATE venue_pr_qr_scans
      SET
        entry_id = ${createdEntry.id}::uuid,
        entered_at = NOW(),
        guest_user_id = COALESCE(${guestUserId}::uuid, guest_user_id),
        updated_at = NOW()
      WHERE id = ${scan.id}::uuid
      RETURNING
        id,
        venue_id,
        event_id,
        pr_membership_id,
        scanned_by_user_id,
        guest_user_id,
        referral_code,
        scanned_at,
        entry_id,
        entered_at,
        metadata,
        created_at,
        updated_at
    `);

    return {
      already_registered: false,
      scan: this.mapPrScan(updatedRows[0] ?? scan),
      entry: {
        ...createdEntry,
        price: this.decimalToNumber(createdEntry.price),
        created_at: this.toIsoString(createdEntry.created_at),
      },
    };
  }

  async getPrDashboardStats(
    venueId: string,
    user?: RequestUser,
    filters?: {
      event_id?: string;
      membership_id?: string;
    },
  ) {
    await this.getVenue(venueId);

    const eventId = filters?.event_id ?? undefined;
    if (eventId) {
      await this.ensureEventBelongsToVenue(eventId, venueId);
    }

    const actorContext = await this.resolvePrActorContext(venueId, user, false);
    const memberRows = await this.loadPrMemberRows(venueId);

    let visibleRows = memberRows;
    if (!actorContext.owner && actorContext.membership) {
      const allowed = this.collectPrSubtree(actorContext.membership.id, memberRows);
      visibleRows = memberRows.filter((row) => allowed.has(row.id));
    }

    if (filters?.membership_id) {
      const target = visibleRows.find((row) => row.id === filters.membership_id);
      if (!target) throw new ForbiddenException('Forbidden');
      visibleRows = [target];
    }

    const visibleIds = new Set(visibleRows.map((row) => row.id));

    const scanRows = await this.prisma.$queryRaw<
      Array<{ pr_membership_id: string; scans_count: number; entries_count: number }>
    >(Prisma.sql`
      SELECT
        pr_membership_id,
        COUNT(*)::int AS scans_count,
        COUNT(entry_id)::int AS entries_count
      FROM venue_pr_qr_scans
      WHERE venue_id = ${venueId}::uuid
        ${eventId ? Prisma.sql`AND event_id = ${eventId}::uuid` : Prisma.empty}
      GROUP BY pr_membership_id
    `);

    const statsByMember = new Map<string, { scans: number; entries: number }>();
    for (const row of scanRows) {
      if (!visibleIds.has(row.pr_membership_id)) continue;
      statsByMember.set(row.pr_membership_id, {
        scans: Number(row.scans_count ?? 0),
        entries: Number(row.entries_count ?? 0),
      });
    }

    const childrenMap = new Map<string, string[]>();
    for (const row of visibleRows) {
      if (!row.parent_membership_id || !visibleIds.has(row.parent_membership_id)) {
        continue;
      }
      const siblings = childrenMap.get(row.parent_membership_id) ?? [];
      siblings.push(row.id);
      childrenMap.set(row.parent_membership_id, siblings);
    }

    const rollupCache = new Map<string, { scans: number; entries: number }>();
    const rollup = (membershipId: string): { scans: number; entries: number } => {
      const cached = rollupCache.get(membershipId);
      if (cached) return cached;

      const own = statsByMember.get(membershipId) ?? { scans: 0, entries: 0 };
      const children = childrenMap.get(membershipId) ?? [];

      const totals = { scans: own.scans, entries: own.entries };
      for (const childId of children) {
        const childTotals = rollup(childId);
        totals.scans += childTotals.scans;
        totals.entries += childTotals.entries;
      }

      rollupCache.set(membershipId, totals);
      return totals;
    };

    const members = visibleRows.map((row) => {
      const own = statsByMember.get(row.id) ?? { scans: 0, entries: 0 };
      const team = rollup(row.id);
      return {
        id: row.id,
        user_id: row.user_id,
        role: this.toPrRoleApi(row.role),
        parent_membership_id: row.parent_membership_id,
        ref_code: row.ref_code,
        is_active: Boolean(row.is_active),
        created_at: this.toIsoString(row.created_at),
        updated_at: this.toIsoString(row.updated_at),
        display_name: row.user_name || row.user_username || row.user_email,
        user: {
          id: row.user_id,
          name: row.user_name,
          username: row.user_username,
          email: row.user_email,
          role: String(row.user_role || '').toLowerCase(),
        },
        stats: {
          scans: own.scans,
          entries: own.entries,
        },
        team_stats: {
          scans: team.scans,
          entries: team.entries,
        },
      };
    });

    const totals = members.reduce(
      (acc, member) => {
        acc.scans += member.stats.scans;
        acc.entries += member.stats.entries;
        return acc;
      },
      { scans: 0, entries: 0 },
    );

    return {
      venue_id: venueId,
      event_id: eventId ?? null,
      scope: actorContext.owner
        ? 'OWNER'
        : actorContext.membership
          ? this.toPrRoleApi(actorContext.membership.role)
          : 'PR',
      can_manage_team: actorContext.owner
        ? true
        : actorContext.membership
          ? this.canManagePrTeam(actorContext.membership.role)
          : false,
      totals,
      members,
      generated_at: new Date().toISOString(),
    };
  }

  async createVenueStationsBulk(
    venueId: string,
    body: CreateVenueStationsBulkDto,
  ): Promise<venue_stations[]> {
    await this.getVenue(venueId);

    const stations = body?.stations;
    if (!Array.isArray(stations) || stations.length === 0) {
      throw new BadRequestException('stations[] is required');
    }
    if (stations.length > 50) {
      throw new BadRequestException('Too many stations (max 50 per request)');
    }

    await this.prisma.$transaction(async (tx) => {
      for (const station of stations) {
        const name = String(station.name || '').trim();
        if (!name) {
          throw new BadRequestException('station name cannot be empty');
        }

        const existing = await tx.venue_stations.findFirst({
          where: {
            venue_id: venueId,
            name: { equals: name, mode: 'insensitive' },
          },
          select: { id: true },
        });

        const payload = {
          name,
          station_type: station.station_type as VenueStationType,
          is_active: station.is_active ?? true,
          sort_order: station.sort_order ?? 0,
        };

        if (existing) {
          await tx.venue_stations.update({
            where: { id: existing.id },
            data: payload,
          });
        } else {
          await tx.venue_stations.create({
            data: {
              venue_id: venueId,
              ...payload,
            },
          });
        }
      }
    });

    return this.listVenueStations(venueId);
  }

  async updateVenueStation(
    venueId: string,
    stationId: string,
    body: UpdateVenueStationDto,
  ): Promise<venue_stations> {
    await this.getVenue(venueId);

    const existing = await this.prisma.venue_stations.findUnique({
      where: { id: stationId },
      select: { id: true, venue_id: true },
    });
    if (!existing || existing.venue_id !== venueId) {
      throw new NotFoundException('Station not found');
    }

    const data: Prisma.venue_stationsUpdateInput = {};

    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new BadRequestException('name cannot be empty');

      const clash = await this.prisma.venue_stations.findFirst({
        where: {
          venue_id: venueId,
          id: { not: stationId },
          name: { equals: name, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (clash) {
        throw new BadRequestException('name already exists for this venue');
      }
      data.name = name;
    }

    if (body.station_type !== undefined) {
      data.station_type = body.station_type as VenueStationType;
    }
    if (body.is_active !== undefined) {
      data.is_active = Boolean(body.is_active);
    }
    if (body.sort_order !== undefined) {
      data.sort_order = body.sort_order;
    }

    return this.prisma.venue_stations.update({
      where: { id: stationId },
      data,
    });
  }

  async deleteVenueStation(
    venueId: string,
    stationId: string,
  ): Promise<venue_stations> {
    await this.getVenue(venueId);

    const existing = await this.prisma.venue_stations.findUnique({
      where: { id: stationId },
    });
    if (!existing || existing.venue_id !== venueId) {
      throw new NotFoundException('Station not found');
    }

    const [entriesCount, barSalesCount, cloakroomSalesCount, tableSalesCount] =
      await this.prisma.$transaction([
        this.prisma.entries.count({ where: { station_id: stationId } }),
        this.prisma.bar_sales.count({ where: { station_id: stationId } }),
        this.prisma.cloakroom_sales.count({ where: { station_id: stationId } }),
        this.prisma.table_sales.count({ where: { station_id: stationId } }),
      ]);

    if (entriesCount + barSalesCount + cloakroomSalesCount + tableSalesCount > 0) {
      throw new BadRequestException(
        'Cannot delete station: operational records are already linked to it',
      );
    }

    return this.prisma.venue_stations.delete({ where: { id: stationId } });
  }

  async createVenueTablesBulk(
    venueId: string,
    body: CreateVenueTablesBulkDto,
  ): Promise<venue_tables[]> {
    await this.getVenue(venueId);

    const tables = body?.tables;
    if (!Array.isArray(tables) || tables.length === 0) {
      throw new BadRequestException('tables[] is required');
    }

    // Keep it safe: avoid accidental huge payloads
    if (tables.length > 300) {
      throw new BadRequestException('Too many tables (max 300 per request)');
    }

    await this.prisma.$transaction(async (tx) => {
      for (const t of tables) {
        if (!t?.nome || typeof t.nome !== 'string') {
          throw new BadRequestException('Each table must have nome');
        }

        const zonaRaw =
          t.zona === null || t.zona === undefined ? '' : String(t.zona).trim();
        const nomeRaw = String(t.nome).trim();
        const zoneMode = zonaRaw.length > 0;
        const normalizedNome = zoneMode
          ? (nomeRaw || zonaRaw)
          : nomeRaw;
        const normalizedZona = zoneMode ? zonaRaw : undefined;

        if (!normalizedNome) {
          throw new BadRequestException('nome cannot be empty');
        }

        const perTesta =
          t.per_testa === null || t.per_testa === undefined
            ? undefined
            : Number(t.per_testa);
        if (
          perTesta !== undefined &&
          (!Number.isFinite(perTesta) || perTesta < 0)
        ) {
          throw new BadRequestException('per_testa must be a number >= 0');
        }

        const costoMinimo =
          t.costo_minimo === null || t.costo_minimo === undefined
            ? undefined
            : Number(t.costo_minimo);
        if (
          costoMinimo !== undefined &&
          (!Number.isFinite(costoMinimo) || costoMinimo < 0)
        ) {
          throw new BadRequestException('costo_minimo must be a number >= 0');
        }

        const personeMax =
          t.persone_max === null || t.persone_max === undefined
            ? undefined
            : Number(t.persone_max);
        if (
          personeMax !== undefined &&
          (!Number.isInteger(personeMax) || personeMax < 1)
        ) {
          throw new BadRequestException('persone_max must be an integer >= 1');
        }

        if (!zoneMode) {
          throw new BadRequestException('zona is required');
        }

        const existingZone = (await tx.venue_tables.findFirst({
          where: {
            venue_id: venueId,
            zona: { equals: zonaRaw, mode: 'insensitive' },
          },
          select: { id: true },
        })) as { id: string } | null;

        if (existingZone) {
          await tx.venue_tables.update({
            where: { id: existingZone.id },
            data: {
              nome: normalizedNome,
              zona: normalizedZona,
              numero: null,
              per_testa: perTesta,
              costo_minimo: costoMinimo,
              persone_max: personeMax,
            },
          });
        } else {
          await tx.venue_tables.create({
            data: {
              venue_id: venueId,
              nome: normalizedNome,
              zona: normalizedZona,
              numero: null,
              per_testa: perTesta,
              costo_minimo: costoMinimo,
              persone_max: personeMax,
            },
          });
        }
      }
    });

    return this.listVenueTables(venueId);
  }

  async deleteVenueTable(
    venueId: string,
    tableId: string,
  ): Promise<venue_tables> {
    await this.getVenue(venueId);

    const existing = (await this.prisma.venue_tables.findUnique({
      where: { id: tableId },
      select: { id: true, venue_id: true },
    })) as { id: string; venue_id: string } | null;
    if (!existing || existing.venue_id !== venueId) {
      throw new NotFoundException('Table not found');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const salesCount = await tx.table_sales.count({
          where: {
            event_table: {
              venue_table_id: tableId,
            },
          },
        });

        if (salesCount > 0) {
          throw new BadRequestException(
            'Cannot delete table: sales are associated with this table',
          );
        }

        await tx.reservations.updateMany({
          where: { venue_table_id: tableId },
          data: { venue_table_id: null },
        });

        await tx.event_tables.deleteMany({
          where: { venue_table_id: tableId },
        });

        return await tx.venue_tables.delete({ where: { id: tableId } });
      });
    } catch (error: unknown) {
      if (error instanceof BadRequestException) throw error;

      const prismaCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';

      if (prismaCode === 'P2003') {
        throw new BadRequestException(
          'Cannot delete table: it is still linked to event data',
        );
      }

      throw error;
    }
  }

  async updateVenueTable(
    venueId: string,
    tableId: string,
    body: UpdateVenueTableDto,
  ): Promise<venue_tables> {
    await this.getVenue(venueId);

    const existing = (await this.prisma.venue_tables.findUnique({
      where: { id: tableId },
      select: { id: true, venue_id: true },
    })) as { id: string; venue_id: string } | null;
    if (!existing || existing.venue_id !== venueId) {
      throw new NotFoundException('Table not found');
    }

    const data: Prisma.venue_tablesUpdateInput = {};

    if (body?.nome !== undefined) {
      const trimmed = String(body.nome).trim();
      if (!trimmed) throw new BadRequestException('nome cannot be empty');
      data.nome = trimmed;
    }

    if (body?.zona !== undefined) {
      const trimmed = String(body.zona).trim();
      if (!trimmed.length) {
        throw new BadRequestException('zona cannot be empty');
      }

      data.zona = trimmed;

      const clashByZone = (await this.prisma.venue_tables.findFirst({
        where: {
          venue_id: venueId,
          id: { not: tableId },
          zona: { equals: trimmed, mode: 'insensitive' },
        },
        select: { id: true },
      })) as { id: string } | null;
      if (clashByZone) {
        throw new BadRequestException('zona already exists for this venue');
      }

      if (!body?.nome) {
        data.nome = trimmed;
      }
    }

    if (body?.per_testa !== undefined && body.per_testa !== null) {
      const v = Number(body.per_testa);
      if (!Number.isFinite(v) || v < 0) {
        throw new BadRequestException('per_testa must be a number >= 0');
      }
      data.per_testa = v;
    }

    if (body?.costo_minimo !== undefined && body.costo_minimo !== null) {
      const v = Number(body.costo_minimo);
      if (!Number.isFinite(v) || v < 0) {
        throw new BadRequestException('costo_minimo must be a number >= 0');
      }
      data.costo_minimo = v;
    }

    if (body?.persone_max !== undefined && body.persone_max !== null) {
      const v = Number(body.persone_max);
      if (!Number.isInteger(v) || v < 1) {
        throw new BadRequestException('persone_max must be an integer >= 1');
      }
      data.persone_max = v;
    }

    if (body?.per_testa === null) data.per_testa = null;
    if (body?.costo_minimo === null) data.costo_minimo = null;
    if (body?.persone_max === null) data.persone_max = null;
    data.numero = null;

    return await this.prisma.venue_tables.update({
      where: { id: tableId },
      data,
    });
  }

  async getStats(venueId: string): Promise<{
    eventsCount: number;
    promosCount: number;
    reservationsCount: number;
    totalReservationAmount: number;
  }> {
    const [eventsCount, promosCount, reservationsCount, reservationsSum] =
      await this.prisma.$transaction([
        this.prisma.events.count({ where: { venue_id: venueId } }),
        this.prisma.promos.count({ where: { venue_id: venueId } }),
        this.prisma.reservations.count({
          where: { event: { venue_id: venueId } },
        }),
        this.prisma.reservations.aggregate({
          where: { event: { venue_id: venueId }, total_amount: { not: null } },
          _sum: { total_amount: true },
        }),
      ]);

    let totalReservationAmount = 0;
    const rawTotal = reservationsSum._sum?.total_amount;
    if (rawTotal !== null && rawTotal !== undefined) {
      const totalAsUnknown = rawTotal as unknown;
      if (
        typeof totalAsUnknown === 'object' &&
        totalAsUnknown !== null &&
        typeof (totalAsUnknown as Record<string, unknown>).toNumber ===
          'function'
      ) {
        totalReservationAmount = (
          totalAsUnknown as Record<string, () => number>
        ).toNumber();
      } else {
        totalReservationAmount = Number(rawTotal) || 0;
      }
    }

    return {
      eventsCount,
      promosCount,
      reservationsCount,
      totalReservationAmount,
    };
  }

  async getAnalyticsOverview(venueId: string, eventId?: string) {
    await this.getVenue(venueId);
    if (eventId) {
      await this.ensureEventBelongsToVenue(eventId, venueId);
    }

    const eventFilter = eventId ? { id: eventId } : { venue_id: venueId };
    const reservationFilter = eventId
      ? { event_id: eventId }
      : { event: { venue_id: venueId } };
    const stayFilter = eventId
      ? { venue_id: venueId, event_id: eventId, duration_ms: { not: null } }
      : { venue_id: venueId, duration_ms: { not: null } };

    const [eventsCount, reservationsCount, entriesCount, ticketOrdersCount, stayAgg, revenue] =
      await Promise.all([
        this.prisma.events.count({ where: eventFilter }),
        this.prisma.reservations.count({ where: reservationFilter }),
        this.prisma.entries.count({
          where: eventId ? { event_id: eventId } : { event: { venue_id: venueId } },
        }),
        this.prisma.ticket_orders.count({
          where: eventId ? { event_id: eventId } : { event: { venue_id: venueId } },
        }),
        this.prisma.venue_stays.aggregate({
          where: stayFilter,
          _avg: { duration_ms: true },
        }),
        this.getRevenueBreakdown(venueId, eventId),
      ]);

    return {
      venue_id: venueId,
      event_id: eventId ?? null,
      generated_at: new Date().toISOString(),
      overview: {
        eventsCount,
        reservationsCount,
        entriesCount,
        ticketOrdersCount,
        avgStayMinutes: this.round(
          this.decimalToNumber(stayAgg._avg.duration_ms) / 60000,
          1,
        ),
        totalRevenue: revenue.totals.totalRevenue,
        entryRevenue: revenue.totals.entryRevenue,
        barRevenue: revenue.totals.barRevenue,
        cloakroomRevenue: revenue.totals.cloakroomRevenue,
        tableRevenue: revenue.totals.tableRevenue,
      },
    };
  }

  async getAnalyticsDemographics(venueId: string, eventId?: string) {
    await this.getVenue(venueId);
    if (eventId) {
      await this.ensureEventBelongsToVenue(eventId, venueId);
    }

    const analytics = await this.getAnalytics(venueId);
    if (!eventId) {
      return {
        venue_id: venueId,
        generated_at: analytics.generated_at,
        audience: analytics.audience,
        avgStayMinutes: analytics.overview.avgStayMinutes,
      };
    }

    const eventSummary = (analytics.events as AnalyticsEventSummary[]).find(
      (event) => event.event_id === eventId,
    );
    return {
      venue_id: venueId,
      event_id: eventId,
      generated_at: analytics.generated_at,
      audience: {
        averageAge: eventSummary?.averageAge ?? null,
        genderSplit: [
          { label: 'Donna', count: eventSummary?.women ?? 0 },
          { label: 'Uomo', count: eventSummary?.men ?? 0 },
          { label: 'Altro', count: eventSummary?.other ?? 0 },
          { label: 'Non dichiarato', count: eventSummary?.unknown ?? 0 },
        ],
        ageBuckets: analytics.audience.ageBuckets,
      },
      note:
        'Le fasce eta sono aggregate a livello venue finche venue_stays/event_presence_events non vengono materializzati per singolo evento.',
    };
  }

  async getRevenueBreakdown(venueId: string, eventId?: string) {
    await this.getVenue(venueId);
    if (eventId) {
      await this.ensureEventBelongsToVenue(eventId, venueId);
    }

    const eventIdSql = eventId ?? null;

    const [paidEntryReservationsAgg, directEntriesAgg, barAgg, cloakAgg, tableAgg, stationRows] =
      await Promise.all([
        this.prisma.reservations.aggregate({
          where: {
            ...(eventId
              ? { event_id: eventId }
              : { event: { venue_id: venueId } }),
            type: ReservationType.entry,
            status: { in: [ReservationStatus.confirmed, ReservationStatus.completed] },
            total_amount: { not: null },
          },
          _sum: { total_amount: true },
        }),
        this.prisma.$queryRaw<Array<{ total: Prisma.Decimal | null }>>(
          Prisma.sql`
            SELECT COALESCE(SUM(e."price"), 0) AS total
            FROM "entries" e
            JOIN "events" ev ON ev."id" = e."event_id"
            LEFT JOIN "reservations" r ON r."checkin_entry_id" = e."id"
            WHERE ev."venue_id" = ${venueId}::uuid
              AND (${eventIdSql}::uuid IS NULL OR e."event_id" = ${eventIdSql}::uuid)
              AND (r."id" IS NULL OR r."total_amount" IS NULL)
          `,
        ),
        this.prisma.bar_sales.aggregate({
          where: eventId
            ? { event_id: eventId }
            : { event: { venue_id: venueId } },
          _sum: { amount: true },
        }),
        this.prisma.cloakroom_sales.aggregate({
          where: eventId
            ? { event_id: eventId }
            : { event: { venue_id: venueId } },
          _sum: { amount: true },
        }),
        this.prisma.event_tables.aggregate({
          where: eventId
            ? { event_id: eventId }
            : { event: { venue_id: venueId } },
          _sum: { pagato_totale: true },
        }),
        this.prisma.$queryRaw<
          Array<{
            channel: string;
            station_id: string | null;
            station_name: string;
            station_type: string;
            total_amount: Prisma.Decimal | null;
            transaction_count: bigint | number;
            last_activity_at: Date | null;
          }>
        >(Prisma.sql`
          SELECT
            rows.channel,
            rows.station_id,
            rows.station_name,
            rows.station_type,
            SUM(rows.total_amount) AS total_amount,
            SUM(rows.transaction_count) AS transaction_count,
            MAX(rows.last_activity_at) AS last_activity_at
          FROM (
            SELECT
              'entry' AS channel,
              e."station_id" AS station_id,
              COALESCE(vs."name", 'Ingresso non assegnato') AS station_name,
              COALESCE(vs."station_type"::text, 'entry') AS station_type,
              COALESCE(SUM(e."price"), 0) AS total_amount,
              COUNT(*)::bigint AS transaction_count,
              MAX(e."created_at") AS last_activity_at
            FROM "entries" e
            JOIN "events" ev ON ev."id" = e."event_id"
            LEFT JOIN "venue_stations" vs ON vs."id" = e."station_id"
            WHERE ev."venue_id" = ${venueId}::uuid
              AND (${eventIdSql}::uuid IS NULL OR e."event_id" = ${eventIdSql}::uuid)
            GROUP BY e."station_id", vs."name", vs."station_type"

            UNION ALL

            SELECT
              'bar' AS channel,
              s."station_id" AS station_id,
              COALESCE(vs."name", 'Bar non assegnato') AS station_name,
              COALESCE(vs."station_type"::text, 'bar') AS station_type,
              COALESCE(SUM(s."amount"), 0) AS total_amount,
              COUNT(*)::bigint AS transaction_count,
              MAX(s."created_at") AS last_activity_at
            FROM "bar_sales" s
            JOIN "events" ev ON ev."id" = s."event_id"
            LEFT JOIN "venue_stations" vs ON vs."id" = s."station_id"
            WHERE ev."venue_id" = ${venueId}::uuid
              AND (${eventIdSql}::uuid IS NULL OR s."event_id" = ${eventIdSql}::uuid)
            GROUP BY s."station_id", vs."name", vs."station_type"

            UNION ALL

            SELECT
              'cloakroom' AS channel,
              s."station_id" AS station_id,
              COALESCE(vs."name", 'Guardaroba non assegnato') AS station_name,
              COALESCE(vs."station_type"::text, 'cloakroom') AS station_type,
              COALESCE(SUM(s."amount"), 0) AS total_amount,
              COUNT(*)::bigint AS transaction_count,
              MAX(s."created_at") AS last_activity_at
            FROM "cloakroom_sales" s
            JOIN "events" ev ON ev."id" = s."event_id"
            LEFT JOIN "venue_stations" vs ON vs."id" = s."station_id"
            WHERE ev."venue_id" = ${venueId}::uuid
              AND (${eventIdSql}::uuid IS NULL OR s."event_id" = ${eventIdSql}::uuid)
            GROUP BY s."station_id", vs."name", vs."station_type"

            UNION ALL

            SELECT
              'table' AS channel,
              s."station_id" AS station_id,
              COALESCE(vs."name", 'Tavoli non assegnati') AS station_name,
              COALESCE(vs."station_type"::text, 'table') AS station_type,
              COALESCE(SUM(s."amount"), 0) AS total_amount,
              COUNT(*)::bigint AS transaction_count,
              MAX(s."created_at") AS last_activity_at
            FROM "table_sales" s
            LEFT JOIN "event_tables" et ON et."id" = s."event_table_id"
            JOIN "events" ev ON ev."id" = COALESCE(s."event_id", et."event_id")
            LEFT JOIN "venue_stations" vs ON vs."id" = s."station_id"
            WHERE ev."venue_id" = ${venueId}::uuid
              AND (${eventIdSql}::uuid IS NULL OR COALESCE(s."event_id", et."event_id") = ${eventIdSql}::uuid)
            GROUP BY s."station_id", vs."name", vs."station_type"
          ) AS rows
          GROUP BY rows.channel, rows.station_id, rows.station_name, rows.station_type
          ORDER BY SUM(rows.total_amount) DESC, SUM(rows.transaction_count) DESC
        `),
      ]);

    const reservationEntryRevenue = this.decimalToNumber(
      paidEntryReservationsAgg._sum.total_amount,
    );
    const directEntryRevenue = this.decimalToNumber(directEntriesAgg[0]?.total ?? null);
    const entryRevenue = reservationEntryRevenue + directEntryRevenue;
    const barRevenue = this.decimalToNumber(barAgg._sum.amount);
    const cloakroomRevenue = this.decimalToNumber(cloakAgg._sum.amount);
    const tableRevenue = this.decimalToNumber(tableAgg._sum.pagato_totale);
    const totalRevenue = entryRevenue + barRevenue + cloakroomRevenue + tableRevenue;

    const stations = stationRows.map((row) => ({
      channel: row.channel,
      station_id: row.station_id,
      station_name: row.station_name,
      station_type: row.station_type,
      total_amount: this.round(this.decimalToNumber(row.total_amount), 2),
      transaction_count: Number(row.transaction_count ?? 0),
      last_activity_at: row.last_activity_at?.toISOString() ?? null,
    }));

    return {
      venue_id: venueId,
      event_id: eventId ?? null,
      generated_at: new Date().toISOString(),
      totals: {
        reservationEntryRevenue: this.round(reservationEntryRevenue, 2),
        directEntryRevenue: this.round(directEntryRevenue, 2),
        entryRevenue: this.round(entryRevenue, 2),
        barRevenue: this.round(barRevenue, 2),
        cloakroomRevenue: this.round(cloakroomRevenue, 2),
        tableRevenue: this.round(tableRevenue, 2),
        totalRevenue: this.round(totalRevenue, 2),
      },
      stations,
      stationTypeCatalog: Object.values(VenueStationType).map((type) => ({
        key: type,
        label: this.stationTypeLabel(type),
      })),
    };
  }

  async getAnalytics(venueId: string) {
    const venue = await this.prisma.venues.findUnique({
      where: { id: venueId },
      select: { id: true, name: true },
    });

    if (!venue) throw new NotFoundException('Venue not found');

    const rawEvents = await this.prisma.events.findMany({
      where: { venue_id: venueId },
      orderBy: [{ date: 'desc' }, { start_time: 'desc' }],
      select: {
        id: true,
        name: true,
        date: true,
        status: true,
        start_time: true,
        end_time: true,
      },
    });

    if (rawEvents.length === 0) {
      return {
        venue_id: venueId,
        venue_name: venue.name,
        generated_at: new Date().toISOString(),
        overview: {
          totalRevenue: 0,
          totalEntries: 0,
          totalReservations: 0,
          totalTableGuests: 0,
          totalPresences: 0,
          avgRevenuePerEvent: 0,
          avgRevenuePerPresence: 0,
          avgStayMinutes: 0,
        },
        audience: {
          uniqueCustomers: 0,
          repeatCustomers: 0,
          repeatRate: 0,
          averageAge: null,
          genderSplit: [],
          ageBuckets: [],
          ageEntryWindows: [],
        },
        bookings: {
          avgLeadDays: 0,
          bestEventWeekday: null,
          bestBookingWeekday: null,
          bestBookingHour: null,
          busiestEntryHour: null,
          byEventWeekday: [],
          byBookingWeekday: [],
          byBookingHour: [],
          leadTimeBuckets: [],
        },
        revenue: {
          channelMix: [],
          averagePerClosedEvent: {
            revenue: 0,
            entriesRevenue: 0,
            barRevenue: 0,
            cloakroomRevenue: 0,
            tablesRevenue: 0,
            entries: 0,
            presences: 0,
          },
          weekdayBenchmarks: [],
        },
        historical: {
          totalEvents: 0,
          closedEvents: 0,
          topEvent: null,
        },
        events: [],
      };
    }

    const eventIds = rawEvents.map((event) => event.id);

    const [
      entries,
      reservations,
      barTotals,
      cloakTotals,
      tableTotals,
      directEntryRevenueRows,
      stayAggregate,
    ] = await Promise.all([
      this.prisma.entries.findMany({
        where: { event_id: { in: eventIds } },
        select: {
          id: true,
          event_id: true,
          user_id: true,
          sesso: true,
          age_bucket: true,
          price: true,
          created_at: true,
          user: {
            select: {
              id: true,
              sesso: true,
              birth_date: true,
            },
          },
        },
      }),
      this.prisma.reservations.findMany({
        where: { event_id: { in: eventIds } },
        select: {
          id: true,
          event_id: true,
          user_id: true,
          type: true,
          status: true,
          guests: true,
          total_amount: true,
          created_at: true,
          checked_in_at: true,
          checkin_entry_id: true,
          user: {
            select: {
              id: true,
              sesso: true,
              birth_date: true,
            },
          },
        },
      }),
      this.prisma.bar_sales.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds } },
        _sum: { amount: true },
      }),
      this.prisma.cloakroom_sales.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds } },
        _sum: { amount: true },
      }),
      this.prisma.event_tables.groupBy({
        by: ['event_id'],
        where: { event_id: { in: eventIds } },
        _sum: { pagato_totale: true, prenotati: true },
      }),
      this.prisma.$queryRaw<Array<{ event_id: string; total: Prisma.Decimal | null }>>(
        Prisma.sql`
          SELECT e."event_id", COALESCE(SUM(e."price"), 0) AS total
          FROM "entries" e
          LEFT JOIN "reservations" r ON r."checkin_entry_id" = e."id"
          WHERE e."event_id" IN (${Prisma.join(eventIds.map((id) => Prisma.sql`${id}::uuid`))})
            AND (r."id" IS NULL OR r."total_amount" IS NULL)
          GROUP BY e."event_id"
        `,
      ),
      this.prisma.venue_stays.aggregate({
        where: { venue_id: venueId, duration_ms: { not: null } },
        _avg: { duration_ms: true },
      }),
    ]);

    const eventMeta = new Map(
      rawEvents.map((event) => [
        event.id,
        {
          id: event.id,
          name: event.name,
          date: event.date,
          status: event.status ?? EventStatus.DRAFT,
          start_time: event.start_time,
          end_time: event.end_time,
        },
      ]),
    );

    const eventMetrics = new Map<
      string,
      {
        event_id: string;
        name: string;
        date: string;
        status: string;
        entriesRevenue: number;
        barRevenue: number;
        cloakroomRevenue: number;
        tablesRevenue: number;
        totalEntries: number;
        totalReservations: number;
        totalTableGuests: number;
        totalPresences: number;
        women: number;
        men: number;
        other: number;
        unknown: number;
        topEntryHour: string | null;
        ageValues: number[];
        hourCounts: Map<string, number>;
      }
    >();

    for (const event of rawEvents) {
      eventMetrics.set(event.id, {
        event_id: event.id,
        name: event.name,
        date: event.date.toISOString(),
        status: String(event.status ?? EventStatus.DRAFT),
        entriesRevenue: 0,
        barRevenue: 0,
        cloakroomRevenue: 0,
        tablesRevenue: 0,
        totalEntries: 0,
        totalReservations: 0,
        totalTableGuests: 0,
        totalPresences: 0,
        women: 0,
        men: 0,
        other: 0,
        unknown: 0,
        topEntryHour: null,
        ageValues: [],
        hourCounts: new Map<string, number>(),
      });
    }

    const entryRevenueMap = new Map<string, number>();
    for (const row of directEntryRevenueRows) {
      entryRevenueMap.set(row.event_id, this.decimalToNumber(row.total));
    }

    for (const row of barTotals) {
      const current = eventMetrics.get(row.event_id);
      if (current) current.barRevenue = this.decimalToNumber(row._sum.amount);
    }

    for (const row of cloakTotals) {
      const current = eventMetrics.get(row.event_id);
      if (current) current.cloakroomRevenue = this.decimalToNumber(row._sum.amount);
    }

    for (const row of tableTotals) {
      const current = eventMetrics.get(row.event_id);
      if (!current) continue;
      current.tablesRevenue = this.decimalToNumber(row._sum.pagato_totale);
      current.totalTableGuests = Number(row._sum.prenotati ?? 0);
    }

    const bookingByEventWeekday = new Map<string, number>();
    const bookingByCreatedWeekday = new Map<string, number>();
    const bookingByHour = new Map<string, number>();
    const leadTimeBuckets = new Map<string, number>([
      ['0-2 gg', 0],
      ['3-7 gg', 0],
      ['8-14 gg', 0],
      ['15+ gg', 0],
    ]);
    const leadDays: number[] = [];
    const userEventsMap = new Map<string, Set<string>>();
    const seenVisits = new Set<string>();
    const reservedEntryIds = new Set(
      reservations
        .filter(
          (reservation) =>
            reservation.checkin_entry_id && reservation.total_amount != null,
        )
        .map((reservation) => reservation.checkin_entry_id as string),
    );

    const globalGenderCounts = new Map<string, number>([
      ['Donna', 0],
      ['Uomo', 0],
      ['Altro', 0],
      ['Non dichiarato', 0],
    ]);
    const audienceAgeValues: number[] = [];
    const ageBucketCounts = new Map<string, number>([
      ['18-20', 0],
      ['21-24', 0],
      ['25-29', 0],
      ['30-34', 0],
      ['35+', 0],
      ['Non disponibile', 0],
    ]);
    const ageEntryWindowMap = new Map<
      string,
      { count: number; hours: number[]; hourCounts: Map<string, number> }
    >();
    const entryHourCounts = new Map<string, number>();

    const addGender = (
      metrics:
        | {
            women: number;
            men: number;
            other: number;
            unknown: number;
          }
        | null,
      gender?: Gender | null,
    ) => {
      if (gender === Gender.F) {
        if (metrics) metrics.women += 1;
        globalGenderCounts.set('Donna', (globalGenderCounts.get('Donna') ?? 0) + 1);
        return;
      }
      if (gender === Gender.M) {
        if (metrics) metrics.men += 1;
        globalGenderCounts.set('Uomo', (globalGenderCounts.get('Uomo') ?? 0) + 1);
        return;
      }
      if (gender === Gender.ALTRO) {
        if (metrics) metrics.other += 1;
        globalGenderCounts.set('Altro', (globalGenderCounts.get('Altro') ?? 0) + 1);
        return;
      }
      if (metrics) metrics.unknown += 1;
      globalGenderCounts.set(
        'Non dichiarato',
        (globalGenderCounts.get('Non dichiarato') ?? 0) + 1,
      );
    };

    const registerVisit = (params: {
      eventId: string;
      userId?: string | null;
      gender?: Gender | null;
      birthDate?: Date | null;
      ageBucket?: AgeBucket | null;
    }) => {
      const metrics = eventMetrics.get(params.eventId);
      if (!metrics) return;

      const computedAge = this.calculateAge(
        params.birthDate,
        eventMeta.get(params.eventId)?.date ?? null,
      );
      const resolvedAge =
        computedAge ?? this.representativeAgeFromStoredBucket(params.ageBucket);
      const resolvedBucket =
        computedAge != null
          ? this.ageBucket(computedAge)
          : this.ageBucketFromStored(params.ageBucket);

      if (!params.userId) {
        addGender(metrics, params.gender);
        if (resolvedAge != null) {
          metrics.ageValues.push(resolvedAge);
          audienceAgeValues.push(resolvedAge);
          ageBucketCounts.set(
            resolvedBucket,
            (ageBucketCounts.get(resolvedBucket) ?? 0) + 1,
          );
        } else {
          ageBucketCounts.set(
            'Non disponibile',
            (ageBucketCounts.get('Non disponibile') ?? 0) + 1,
          );
        }
        return;
      }

      const visitKey = `${params.userId}:${params.eventId}`;
      if (seenVisits.has(visitKey)) return;
      seenVisits.add(visitKey);

      if (!userEventsMap.has(params.userId)) {
        userEventsMap.set(params.userId, new Set<string>());
      }
      userEventsMap.get(params.userId)?.add(params.eventId);

      addGender(metrics, params.gender);

      if (resolvedAge != null) {
        metrics.ageValues.push(resolvedAge);
        audienceAgeValues.push(resolvedAge);
        ageBucketCounts.set(
          resolvedBucket,
          (ageBucketCounts.get(resolvedBucket) ?? 0) + 1,
        );
      } else {
        ageBucketCounts.set(
          'Non disponibile',
          (ageBucketCounts.get('Non disponibile') ?? 0) + 1,
        );
      }
    };

    for (const entry of entries) {
      const metrics = eventMetrics.get(entry.event_id);
      if (!metrics) continue;

      metrics.totalEntries += 1;

      const hourLabel = this.hourLabelFromDate(entry.created_at);
      if (hourLabel) {
        metrics.hourCounts.set(hourLabel, (metrics.hourCounts.get(hourLabel) ?? 0) + 1);
        entryHourCounts.set(hourLabel, (entryHourCounts.get(hourLabel) ?? 0) + 1);
      }

      registerVisit({
        eventId: entry.event_id,
        userId: entry.user_id,
        gender: entry.user?.sesso ?? entry.sesso,
        birthDate: entry.user?.birth_date,
        ageBucket: entry.age_bucket,
      });

      const computedAge = this.calculateAge(
        entry.user?.birth_date,
        eventMeta.get(entry.event_id)?.date ?? null,
      );
      const bucket =
        computedAge != null
          ? this.ageBucket(computedAge)
          : this.ageBucketFromStored(entry.age_bucket);
      const currentBucket = ageEntryWindowMap.get(bucket) ?? {
        count: 0,
        hours: [],
        hourCounts: new Map<string, number>(),
      };

      currentBucket.count += 1;
      if (entry.created_at) {
        const hourValue = entry.created_at.getHours() + entry.created_at.getMinutes() / 60;
        currentBucket.hours.push(hourValue);
      }
      if (hourLabel) {
        currentBucket.hourCounts.set(
          hourLabel,
          (currentBucket.hourCounts.get(hourLabel) ?? 0) + 1,
        );
      }
      ageEntryWindowMap.set(bucket, currentBucket);

      if (!reservedEntryIds.has(entry.id) && entry.user_id) {
        const bucketKey =
          computedAge != null
            ? this.ageBucket(computedAge)
            : this.ageBucketFromStored(entry.age_bucket);
        ageBucketCounts.set(
          bucketKey,
          ageBucketCounts.get(bucketKey) ?? 0,
        );
      }
    }

    for (const reservation of reservations) {
      const metrics = eventMetrics.get(reservation.event_id);
      const meta = eventMeta.get(reservation.event_id);
      if (!metrics || !meta) continue;

      if (reservation.status !== ReservationStatus.cancelled) {
        metrics.totalReservations += 1;

        const eventWeekday = this.weekdayLabels[meta.date.getDay()] ?? 'N/D';
        const bookingWeekday = this.weekdayLabels[reservation.created_at.getDay()] ?? 'N/D';
        const bookingHour = this.hourLabelFromDate(reservation.created_at) ?? 'N/D';

        bookingByEventWeekday.set(
          eventWeekday,
          (bookingByEventWeekday.get(eventWeekday) ?? 0) + 1,
        );
        bookingByCreatedWeekday.set(
          bookingWeekday,
          (bookingByCreatedWeekday.get(bookingWeekday) ?? 0) + 1,
        );
        bookingByHour.set(bookingHour, (bookingByHour.get(bookingHour) ?? 0) + 1);

        const leadDaysValue = Math.max(
          0,
          Math.round(
            (this.startOfDay(meta.date).getTime() - this.startOfDay(reservation.created_at).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        );
        leadDays.push(leadDaysValue);

        if (leadDaysValue <= 2) leadTimeBuckets.set('0-2 gg', (leadTimeBuckets.get('0-2 gg') ?? 0) + 1);
        else if (leadDaysValue <= 7) leadTimeBuckets.set('3-7 gg', (leadTimeBuckets.get('3-7 gg') ?? 0) + 1);
        else if (leadDaysValue <= 14) leadTimeBuckets.set('8-14 gg', (leadTimeBuckets.get('8-14 gg') ?? 0) + 1);
        else leadTimeBuckets.set('15+ gg', (leadTimeBuckets.get('15+ gg') ?? 0) + 1);

        registerVisit({
          eventId: reservation.event_id,
          userId: reservation.user_id,
          gender: reservation.user?.sesso ?? null,
          birthDate: reservation.user?.birth_date,
        });
      }

      if (
        reservation.type === ReservationType.entry &&
        (reservation.status === ReservationStatus.confirmed ||
          reservation.status === ReservationStatus.completed) &&
        reservation.total_amount != null
      ) {
        metrics.entriesRevenue += this.decimalToNumber(reservation.total_amount);
      }
    }

    for (const [eventId, revenue] of entryRevenueMap.entries()) {
      const metrics = eventMetrics.get(eventId);
      if (metrics) metrics.entriesRevenue += revenue;
    }

    const eventSummaries: AnalyticsEventSummary[] = Array.from(eventMetrics.values())
      .map((metrics) => {
        const totalRevenue =
          metrics.entriesRevenue +
          metrics.barRevenue +
          metrics.cloakroomRevenue +
          metrics.tablesRevenue;
        const totalPresences = metrics.totalEntries + metrics.totalTableGuests;
        const topEntryHour = this.topCountItem(metrics.hourCounts)?.label ?? null;

        return {
          event_id: metrics.event_id,
          name: metrics.name,
          date: metrics.date,
          status: metrics.status,
          totalRevenue: this.round(totalRevenue, 2),
          entriesRevenue: this.round(metrics.entriesRevenue, 2),
          barRevenue: this.round(metrics.barRevenue, 2),
          cloakroomRevenue: this.round(metrics.cloakroomRevenue, 2),
          tablesRevenue: this.round(metrics.tablesRevenue, 2),
          totalEntries: metrics.totalEntries,
          totalReservations: metrics.totalReservations,
          totalTableGuests: metrics.totalTableGuests,
          totalPresences,
          avgSpendPerPresence:
            totalPresences > 0 ? this.round(totalRevenue / totalPresences, 2) : 0,
          averageAge:
            metrics.ageValues.length > 0 ? this.average(metrics.ageValues, 1) : null,
          topEntryHour,
          women: metrics.women,
          men: metrics.men,
          other: metrics.other,
          unknown: metrics.unknown,
        };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const closedEvents = eventSummaries.filter((event) => event.status === String(EventStatus.CLOSED));
    const comparisonBase = closedEvents.length > 0 ? closedEvents : eventSummaries;

    const overviewTotals = eventSummaries.reduce(
      (acc, event) => {
        acc.totalRevenue += event.totalRevenue;
        acc.totalEntries += event.totalEntries;
        acc.totalReservations += event.totalReservations;
        acc.totalTableGuests += event.totalTableGuests;
        acc.totalPresences += event.totalPresences;
        acc.entriesRevenue += event.entriesRevenue;
        acc.barRevenue += event.barRevenue;
        acc.cloakroomRevenue += event.cloakroomRevenue;
        acc.tablesRevenue += event.tablesRevenue;
        return acc;
      },
      {
        totalRevenue: 0,
        totalEntries: 0,
        totalReservations: 0,
        totalTableGuests: 0,
        totalPresences: 0,
        entriesRevenue: 0,
        barRevenue: 0,
        cloakroomRevenue: 0,
        tablesRevenue: 0,
      },
    );

    const weekdayBenchmarksMap = new Map<
      string,
      {
        revenue: number[];
        entries: number[];
        presences: number[];
      }
    >();

    for (const event of closedEvents) {
      const weekday = this.weekdayLabels[new Date(event.date).getDay()] ?? 'N/D';
      const current = weekdayBenchmarksMap.get(weekday) ?? {
        revenue: [],
        entries: [],
        presences: [],
      };
      current.revenue.push(event.totalRevenue);
      current.entries.push(event.totalEntries);
      current.presences.push(event.totalPresences);
      weekdayBenchmarksMap.set(weekday, current);
    }

    const weekdayBenchmarks = Array.from(weekdayBenchmarksMap.entries()).map(
      ([label, value]) => ({
        label,
        eventCount: value.revenue.length,
        avgRevenue: this.average(value.revenue, 2),
        avgEntries: this.average(value.entries, 1),
        avgPresences: this.average(value.presences, 1),
      }),
    );

    const totalGenderCount = Array.from(globalGenderCounts.values()).reduce(
      (acc, value) => acc + value,
      0,
    );

    const repeatCustomers = Array.from(userEventsMap.values()).filter(
      (eventsPerUser) => eventsPerUser.size > 1,
    ).length;
    const uniqueCustomers = userEventsMap.size;

    return {
      venue_id: venueId,
      venue_name: venue.name,
      generated_at: new Date().toISOString(),
      overview: {
        totalRevenue: this.round(overviewTotals.totalRevenue, 2),
        totalEntries: overviewTotals.totalEntries,
        totalReservations: overviewTotals.totalReservations,
        totalTableGuests: overviewTotals.totalTableGuests,
        totalPresences: overviewTotals.totalPresences,
        avgRevenuePerEvent:
          eventSummaries.length > 0
            ? this.round(overviewTotals.totalRevenue / eventSummaries.length, 2)
            : 0,
        avgRevenuePerPresence:
          overviewTotals.totalPresences > 0
            ? this.round(
                overviewTotals.totalRevenue / overviewTotals.totalPresences,
                2,
              )
            : 0,
        avgStayMinutes:
          stayAggregate._avg.duration_ms == null
            ? 0
            : this.round(this.decimalToNumber(stayAggregate._avg.duration_ms) / 60000, 1),
      },
      audience: {
        uniqueCustomers,
        repeatCustomers,
        repeatRate:
          uniqueCustomers > 0
            ? this.round((repeatCustomers / uniqueCustomers) * 100, 1)
            : 0,
        averageAge:
          audienceAgeValues.length > 0 ? this.average(audienceAgeValues, 1) : null,
        genderSplit: this.distributionFromMap(globalGenderCounts, totalGenderCount),
        ageBuckets: this.distributionFromMap(ageBucketCounts).filter(
          (item) => item.count > 0,
        ),
        ageEntryWindows: Array.from(ageEntryWindowMap.entries())
          .map(([label, value]) => ({
            label,
            count: value.count,
            avgEntryHour: this.averageHourLabel(value.hours),
            peakEntryHour: this.topCountItem(value.hourCounts)?.label ?? null,
          }))
          .sort((a, b) => b.count - a.count),
      },
      bookings: {
        avgLeadDays: this.average(leadDays, 1),
        bestEventWeekday: this.topCountItem(bookingByEventWeekday),
        bestBookingWeekday: this.topCountItem(bookingByCreatedWeekday),
        bestBookingHour: this.topCountItem(bookingByHour),
        busiestEntryHour: this.topCountItem(entryHourCounts),
        byEventWeekday: this.distributionFromMap(bookingByEventWeekday),
        byBookingWeekday: this.distributionFromMap(bookingByCreatedWeekday),
        byBookingHour: this.distributionFromMap(bookingByHour),
        leadTimeBuckets: this.distributionFromMap(leadTimeBuckets),
      },
      revenue: {
        channelMix: [
          { label: 'Ingressi', value: this.round(overviewTotals.entriesRevenue, 2) },
          { label: 'Bar', value: this.round(overviewTotals.barRevenue, 2) },
          { label: 'Guardaroba', value: this.round(overviewTotals.cloakroomRevenue, 2) },
          { label: 'Tavoli', value: this.round(overviewTotals.tablesRevenue, 2) },
        ]
          .map((item) => ({
            ...item,
            share:
              overviewTotals.totalRevenue > 0
                ? this.round((item.value / overviewTotals.totalRevenue) * 100, 1)
                : 0,
          }))
          .sort((a, b) => b.value - a.value),
        averagePerClosedEvent: {
          revenue: this.average(comparisonBase.map((event) => event.totalRevenue), 2),
          entriesRevenue: this.average(
            comparisonBase.map((event) => event.entriesRevenue),
            2,
          ),
          barRevenue: this.average(comparisonBase.map((event) => event.barRevenue), 2),
          cloakroomRevenue: this.average(
            comparisonBase.map((event) => event.cloakroomRevenue),
            2,
          ),
          tablesRevenue: this.average(
            comparisonBase.map((event) => event.tablesRevenue),
            2,
          ),
          entries: this.average(comparisonBase.map((event) => event.totalEntries), 1),
          presences: this.average(
            comparisonBase.map((event) => event.totalPresences),
            1,
          ),
        },
        weekdayBenchmarks,
      },
      historical: {
        totalEvents: eventSummaries.length,
        closedEvents: closedEvents.length,
        topEvent:
          [...eventSummaries].sort((a, b) => b.totalRevenue - a.totalRevenue)[0] ?? null,
      },
      events: eventSummaries,
    };
  }
}
