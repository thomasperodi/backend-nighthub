import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseStorageService } from '../common/storage/supabase-storage.service';
import { BadgesService } from '../badges/badges.service';
import { AuditLogService } from '../common/audit/audit-log.service';
import { TtlCache } from '../common/ttl-cache';
import { geocodeAddress } from '../common/geocoding';
import type { RequestUser } from '../auth/types';
import {
  AgeBucket,
  EntryMethod,
  EventStatus,
  Gender,
  Prisma,
  ReservationStatus,
  ReservationType,
  VenueFloorLandmarkType,
  VenueStationType,
  VenueTableBookingPolicy,
  events,
  promos,
  venue_floor_landmarks,
  venue_floor_plans,
  venue_table_zones,
  venue_tables,
  venue_stations,
  venues,
} from '@prisma/client';
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
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { isAbsolute, resolve as resolvePath } from 'path';
import { PKPass } from 'passkit-generator';

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

type VenueFloorPlanPayload = venue_floor_plans & {
  landmarks: venue_floor_landmarks[];
  zones: venue_table_zones[];
  tables: venue_tables[];
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
  organization_id: string | null;
};

type PrMemberListRow = PrMembershipRow & {
  user_name: string | null;
  user_username: string | null;
  user_email: string;
  user_role: string;
  organization_name: string | null;
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

type PrSeasonPassStatusDb = 'active' | 'revoked' | 'expired';

type PrSeasonPassRow = {
  id: string;
  venue_id: string;
  pr_membership_id: string;
  user_id: string;
  status: PrSeasonPassStatusDb;
  valid_from: Date;
  valid_until: Date;
  qr_token: string;
  serial_number: string;
  wallet_apple_url: string | null;
  wallet_google_url: string | null;
  wallet_last_issued_at: Date | null;
  revoked_at: Date | null;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
  membership_role: PrNetworkRoleDb;
  membership_is_active: boolean;
};

type PrSeasonPassAppleDownloadRow = {
  id: string;
  venue_id: string;
  pr_membership_id: string;
  user_id: string;
  status: PrSeasonPassStatusDb;
  valid_from: Date;
  valid_until: Date;
  qr_token: string;
  serial_number: string;
  revoked_at: Date | null;
  venue_name: string;
  venue_city: string | null;
  user_name: string | null;
  user_username: string | null;
  user_email: string;
  membership_role: PrNetworkRoleDb;
  membership_is_active: boolean;
  wallet_logo_path: string | null;
  wallet_background_color: string | null;
  wallet_foreground_color: string | null;
  wallet_label_color: string | null;
};

@Injectable()
export class VenuesService {
  // Short-TTL in-process cache for the expensive analytics aggregates (audit §6: the real
  // fix is pre-aggregation, but a short TTL cache is a safe, low-risk stopgap that
  // deduplicates repeated/polled hits without changing the response shape or staleness
  // tolerance the frontend already has (these views already accept `s-maxage` HTTP caching).
  private readonly analyticsCache = new TtlCache();
  private static readonly ANALYTICS_CACHE_TTL_MS = 15_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
    private readonly badgesService: BadgesService,
    private readonly auditLog: AuditLogService,
  ) {}

  private evaluateBadges(userId: string | null | undefined) {
    if (!userId) return;
    void this.badgesService.evaluateForUser(userId).catch(() => {});
  }

  private readonly minimalPassPngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+RhsAAAAASUVORK5CYII=',
    'base64',
  );

  private readonly weekdayLabels = [
    'Dom',
    'Lun',
    'Mar',
    'Mer',
    'Gio',
    'Ven',
    'Sab',
  ];

  private isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(value || '').trim(),
    );
  }

  private buildInternalAppleWalletUrl(
    passId: string,
    qrToken: string,
  ): string | null {
    if (!passId || !qrToken) return null;
    return `/api/venues/passes/apple/${encodeURIComponent(passId)}?token=${encodeURIComponent(qrToken)}`;
  }

  private readBufferFromEnv(
    base64EnvName: string,
    pathEnvName: string,
  ): Buffer | null {
    const base64Value = String(process.env[base64EnvName] || '').trim();
    if (base64Value) {
      if (base64Value.includes('-----BEGIN')) {
        return Buffer.from(base64Value.replace(/\\n/g, '\n'));
      }
      try {
        return Buffer.from(base64Value, 'base64');
      } catch {
        throw new InternalServerErrorException(
          `${base64EnvName} is not a valid base64 payload`,
        );
      }
    }

    const pathValue = String(process.env[pathEnvName] || '').trim();
    if (!pathValue) return null;

    try {
      const resolvedPath = isAbsolute(pathValue)
        ? pathValue
        : resolvePath(process.cwd(), pathValue);
      return readFileSync(resolvedPath);
    } catch {
      throw new InternalServerErrorException(
        `${pathEnvName} points to an unreadable file`,
      );
    }
  }

  private readBufferFromEnvCandidates(
    entries: Array<{ base64EnvName: string; pathEnvName: string }>,
  ): Buffer | null {
    for (const entry of entries) {
      const value = this.readBufferFromEnv(
        entry.base64EnvName,
        entry.pathEnvName,
      );
      if (value) return value;
    }
    return null;
  }

  private getAppleWalletPasskitConfig() {
    const passTypeIdentifier = String(
      process.env.APPLE_WALLET_PASS_TYPE_IDENTIFIER ||
        process.env.WALLET_APPLE_PASS_TYPE_IDENTIFIER ||
        '',
    ).trim();
    const teamIdentifier = String(
      process.env.APPLE_WALLET_TEAM_IDENTIFIER ||
        process.env.WALLET_APPLE_TEAM_IDENTIFIER ||
        '',
    ).trim();

    const organizationName = String(
      process.env.APPLE_WALLET_ORGANIZATION_NAME ||
        process.env.WALLET_APPLE_ORGANIZATION_NAME ||
        'NightHub',
    ).trim();
    const logoText = String(
      process.env.APPLE_WALLET_LOGO_TEXT ||
        process.env.WALLET_APPLE_LOGO_TEXT ||
        'NightHub PR',
    ).trim();

    if (!passTypeIdentifier) {
      throw new InternalServerErrorException(
        'Missing APPLE_WALLET_PASS_TYPE_IDENTIFIER',
      );
    }
    if (!teamIdentifier) {
      throw new InternalServerErrorException(
        'Missing APPLE_WALLET_TEAM_IDENTIFIER',
      );
    }

    const wwdr = this.readBufferFromEnvCandidates([
      {
        base64EnvName: 'APPLE_WALLET_WWDR_BASE64',
        pathEnvName: 'APPLE_WALLET_WWDR_PATH',
      },
      {
        base64EnvName: 'WALLET_APPLE_WWDR_BASE64',
        pathEnvName: 'WALLET_APPLE_WWDR_PATH',
      },
    ]);
    const signerCert = this.readBufferFromEnvCandidates([
      {
        base64EnvName: 'APPLE_WALLET_SIGNER_CERT_BASE64',
        pathEnvName: 'APPLE_WALLET_SIGNER_CERT_PATH',
      },
      {
        base64EnvName: 'WALLET_APPLE_SIGNER_CERT_BASE64',
        pathEnvName: 'WALLET_APPLE_SIGNER_CERT_PATH',
      },
    ]);
    const signerKey = this.readBufferFromEnvCandidates([
      {
        base64EnvName: 'APPLE_WALLET_SIGNER_KEY_BASE64',
        pathEnvName: 'APPLE_WALLET_SIGNER_KEY_PATH',
      },
      {
        base64EnvName: 'WALLET_APPLE_SIGNER_KEY_BASE64',
        pathEnvName: 'WALLET_APPLE_SIGNER_KEY_PATH',
      },
    ]);

    const signerKeyPassphrase =
      String(
        process.env.APPLE_WALLET_SIGNER_KEY_PASSPHRASE ||
          process.env.WALLET_APPLE_SIGNER_KEY_PASSPHRASE ||
          '',
      ).trim() || undefined;

    if (!wwdr || !signerCert || !signerKey) {
      throw new InternalServerErrorException(
        'Apple Wallet certificates are not configured (WWDR, signer cert, signer key)',
      );
    }

    return {
      passTypeIdentifier,
      teamIdentifier,
      organizationName,
      logoText,
      wwdr,
      signerCert,
      signerKey,
      signerKeyPassphrase,
    };
  }

  private async buildPrSeasonPassApplePkpass(
    row: PrSeasonPassAppleDownloadRow,
  ): Promise<Buffer> {
    const config = this.getAppleWalletPasskitConfig();

    // Fase 7 "tessere custom": per-venue branding, additive over the hardcoded defaults
    // below - a venue with no venue_wallet_templates row (the common case today) gets
    // exactly the same pass it always did. Google Wallet has no equivalent (no real API
    // integration exists, see the Organizations/Fase 7 audit).
    const logoBuffer = row.wallet_logo_path
      ? ((await this.storage.downloadPublicImageBuffer(row.wallet_logo_path)) ??
        this.minimalPassPngBuffer)
      : this.minimalPassPngBuffer;
    const backgroundColor = row.wallet_background_color || 'rgb(18, 20, 25)';
    const foregroundColor = row.wallet_foreground_color || 'rgb(245, 247, 251)';
    const labelColor = row.wallet_label_color || 'rgb(216, 179, 106)';

    const holderName = row.user_name || row.user_username || row.user_email;
    const qrPayload = JSON.stringify(
      this.buildPrSeasonPassQrPayload({
        passId: row.id,
        venueId: row.venue_id,
        membershipId: row.pr_membership_id,
        userId: row.user_id,
        qrToken: row.qr_token,
        serialNumber: row.serial_number,
        validUntil: row.valid_until,
      }),
    );

    const passJson = {
      formatVersion: 1 as const,
      serialNumber: row.serial_number,
      description: `Pass stagionale PR - ${row.venue_name}`,
      organizationName: config.organizationName,
      passTypeIdentifier: config.passTypeIdentifier,
      teamIdentifier: config.teamIdentifier,
      logoText: config.logoText,
      backgroundColor,
      foregroundColor,
      labelColor,
      expirationDate: row.valid_until.toISOString(),
      sharingProhibited: false,
      generic: {
        primaryFields: [
          {
            key: 'venue',
            label: 'LOCALE',
            value: row.venue_name,
          },
        ],
        secondaryFields: [
          {
            key: 'holder',
            label: 'PR',
            value: holderName,
          },
          {
            key: 'role',
            label: 'RUOLO',
            value: this.toPrRoleApi(row.membership_role),
          },
        ],
        auxiliaryFields: [
          {
            key: 'valid_until',
            label: 'VALIDO FINO',
            value: row.valid_until.toISOString().slice(0, 10),
          },
        ],
        backFields: [
          {
            key: 'serial_number',
            label: 'Seriale pass',
            value: row.serial_number,
          },
          {
            key: 'membership_id',
            label: 'Membership',
            value: row.pr_membership_id,
          },
          {
            key: 'city',
            label: 'Citta',
            value: row.venue_city || '-',
          },
        ],
      },
    };

    const pass = new PKPass(
      {
        // icon.* stays the minimal placeholder regardless of branding: Apple requires it at
        // a specific small square size (~29pt) and this doesn't resize uploaded assets - only
        // logo.* (more forgiving on aspect/size) uses the venue's uploaded logo, if any.
        'icon.png': this.minimalPassPngBuffer,
        'icon@2x.png': this.minimalPassPngBuffer,
        'icon@3x.png': this.minimalPassPngBuffer,
        'logo.png': logoBuffer,
        'logo@2x.png': logoBuffer,
        'logo@3x.png': logoBuffer,
        'pass.json': Buffer.from(JSON.stringify(passJson)),
      },
      {
        wwdr: config.wwdr,
        signerCert: config.signerCert,
        signerKey: config.signerKey,
        signerKeyPassphrase: config.signerKeyPassphrase,
      },
    );

    pass.setBarcodes(qrPayload);
    return pass.getAsBuffer();
  }

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

  private normalizeManagedImagePath(
    value: string | null | undefined,
    prefix: 'users' | 'venues',
  ): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;

    const input = String(value).trim();
    if (!input) return null;

    if (/^data:image\//i.test(input)) {
      throw new BadRequestException(
        'image must be uploaded before updating the venue',
      );
    }

    const sanitizedInput = input.replace(/[?#].*$/, '');
    const match = new RegExp(
      `(^|/)(${prefix}/[A-Za-z0-9._-]+\\.(?:png|jpe?g|webp))$`,
      'i',
    ).exec(sanitizedInput);

    if (!match?.[2]) {
      throw new BadRequestException(
        `image must be a valid ${prefix} storage path`,
      );
    }

    return match[2];
  }

  private isManagedImagePath(
    value: string | null | undefined,
    prefix: 'users' | 'venues',
  ): boolean {
    if (!value) return false;
    return new RegExp(
      `(^|/)${prefix}/[A-Za-z0-9._-]+\\.(?:png|jpe?g|webp)$`,
      'i',
    ).test(value.replace(/[?#].*$/, ''));
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
        throw new BadRequestException(
          `Unsupported bar price key: ${key || 'unknown'}`,
        );
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
    const ref =
      referenceDate && !Number.isNaN(referenceDate.getTime())
        ? referenceDate
        : new Date();
    let age = ref.getFullYear() - birthDate.getFullYear();
    const monthDiff = ref.getMonth() - birthDate.getMonth();
    const beforeBirthday =
      monthDiff < 0 || (monthDiff === 0 && ref.getDate() < birthDate.getDate());
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
    const resolvedTotal =
      total ??
      Array.from(source.values()).reduce((acc, value) => acc + value, 0);
    return Array.from(source.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({
        label,
        count,
        share:
          resolvedTotal > 0 ? this.round((count / resolvedTotal) * 100, 1) : 0,
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

  private normalizeAppRole(
    role: unknown,
  ): 'client' | 'staff' | 'venue' | 'admin' | '' {
    const normalized = String(role ?? '')
      .trim()
      .toLowerCase();
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
    const normalized = String(role || '')
      .trim()
      .toLowerCase();
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

  private normalizeManualGenderInput(
    gender?: 'M' | 'F' | 'ALTRO',
  ): Gender | null {
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

  // Base32-ish (Crockford, no ambiguous chars) random suffix - deliberately NOT derived from
  // the PR's name/username, so `?pr=CODE` in a shared link can't be guessed or brute-forced
  // just by knowing (or trying) a PR's display name. Kept short since it only needs to be
  // unique per-venue, not globally.
  private randomRefCodeSuffix(length = 6): string {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += alphabet[bytes[i] % alphabet.length];
    }
    return out;
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
      organization_id: row.organization_id,
      organization: row.organization_id
        ? { id: row.organization_id, name: row.organization_name }
        : null,
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

  private resolvePrSeasonPassStatus(
    status: PrSeasonPassStatusDb,
    validUntil: Date,
    revokedAt: Date | null,
  ): 'ACTIVE' | 'REVOKED' | 'EXPIRED' {
    if (revokedAt || status === 'revoked') return 'REVOKED';
    if (status === 'expired') return 'EXPIRED';
    if (validUntil.getTime() < Date.now()) return 'EXPIRED';
    return 'ACTIVE';
  }

  private buildPrSeasonPassQrPayload(params: {
    passId: string;
    venueId: string;
    membershipId: string;
    userId: string;
    qrToken: string;
    serialNumber: string;
    validUntil: Date;
  }) {
    return {
      type: 'pr_season_pass',
      pass_id: params.passId,
      venue_id: params.venueId,
      pr_membership_id: params.membershipId,
      user_id: params.userId,
      qr_token: params.qrToken,
      serial_number: params.serialNumber,
      valid_until: params.validUntil.toISOString(),
      iat: new Date().toISOString(),
      ver: 1,
    };
  }

  private applyWalletUrlTemplate(
    template: string | undefined,
    payload: Record<string, string>,
  ): string | null {
    const source = String(template || '').trim();
    if (!source) return null;
    let resolved = source;
    for (const [key, value] of Object.entries(payload)) {
      const encoded = encodeURIComponent(value);
      resolved = resolved
        .split(`{{${key}}}`)
        .join(encoded)
        .split(`:${key}`)
        .join(encoded);
    }
    return resolved;
  }

  private buildPrSeasonPassWalletLinks(params: {
    passId: string;
    venueId: string;
    membershipId: string;
    userId: string;
    qrToken: string;
    serialNumber: string;
    validUntil: Date;
  }) {
    const payload = {
      pass_id: params.passId,
      venue_id: params.venueId,
      pr_membership_id: params.membershipId,
      user_id: params.userId,
      qr_token: params.qrToken,
      serial_number: params.serialNumber,
      valid_until: params.validUntil.toISOString(),
    };

    const templatedAppleUrl = this.applyWalletUrlTemplate(
      process.env.WALLET_APPLE_PASS_URL_TEMPLATE,
      payload,
    );
    const fallbackAppleUrl = this.buildInternalAppleWalletUrl(
      params.passId,
      params.qrToken,
    );

    return {
      apple: templatedAppleUrl || fallbackAppleUrl,
      google: this.applyWalletUrlTemplate(
        process.env.WALLET_GOOGLE_PASS_URL_TEMPLATE,
        payload,
      ),
    };
  }

  private buildDefaultSeasonPassValidity(membershipCreatedAt?: Date | null) {
    const validFrom =
      membershipCreatedAt instanceof Date
        ? new Date(membershipCreatedAt)
        : new Date();
    const now = new Date();
    const seasonEnd = new Date(
      Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59),
    );
    const validUntil =
      seasonEnd.getTime() > validFrom.getTime()
        ? seasonEnd
        : new Date(validFrom.getTime() + 1000 * 60 * 60 * 24 * 30);
    return { validFrom, validUntil };
  }

  private mapPrSeasonPass(row: PrSeasonPassRow) {
    const status = this.resolvePrSeasonPassStatus(
      row.status,
      row.valid_until,
      row.revoked_at,
    );

    return {
      id: row.id,
      venue_id: row.venue_id,
      pr_membership_id: row.pr_membership_id,
      user_id: row.user_id,
      role: this.toPrRoleApi(row.membership_role),
      status,
      membership_is_active: Boolean(row.membership_is_active),
      valid_from: this.toIsoString(row.valid_from),
      valid_until: this.toIsoString(row.valid_until),
      revoked_at: row.revoked_at ? this.toIsoString(row.revoked_at) : null,
      serial_number: row.serial_number,
      wallet_apple_url: row.wallet_apple_url,
      wallet_google_url: row.wallet_google_url,
      wallet_last_issued_at: row.wallet_last_issued_at
        ? this.toIsoString(row.wallet_last_issued_at)
        : null,
      qr_data: JSON.stringify(
        this.buildPrSeasonPassQrPayload({
          passId: row.id,
          venueId: row.venue_id,
          membershipId: row.pr_membership_id,
          userId: row.user_id,
          qrToken: row.qr_token,
          serialNumber: row.serial_number,
          validUntil: row.valid_until,
        }),
      ),
      created_at: this.toIsoString(row.created_at),
      updated_at: this.toIsoString(row.updated_at),
    };
  }

  private async loadPrSeasonPassByMembership(
    venueId: string,
    membershipId: string,
  ): Promise<PrSeasonPassRow | null> {
    const rows = await this.prisma.$queryRaw<PrSeasonPassRow[]>(Prisma.sql`
      SELECT
        p.id,
        p.venue_id,
        p.pr_membership_id,
        p.user_id,
        p.status::text AS status,
        p.valid_from,
        p.valid_until,
        p.qr_token,
        p.serial_number,
        p.wallet_apple_url,
        p.wallet_google_url,
        p.wallet_last_issued_at,
        p.revoked_at,
        p.metadata,
        p.created_at,
        p.updated_at,
        m.role::text AS membership_role,
        m.is_active AS membership_is_active
      FROM venue_pr_membership_passes p
      JOIN venue_pr_memberships m ON m.id = p.pr_membership_id
      WHERE p.venue_id = ${venueId}::uuid
        AND p.pr_membership_id = ${membershipId}::uuid
      LIMIT 1
    `);
    return rows[0] ?? null;
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
        m.organization_id,
        u.name AS user_name,
        u.username AS user_username,
        u.email AS user_email,
        u.role::text AS user_role,
        o.name AS organization_name
      FROM venue_pr_memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN organizations o ON o.id = m.organization_id
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
        m.organization_id,
        u.name AS user_name,
        u.username AS user_username,
        u.email AS user_email,
        u.role::text AS user_role,
        o.name AS organization_name
      FROM venue_pr_memberships m
      JOIN users u ON u.id = m.user_id
      LEFT JOIN organizations o ON o.id = m.organization_id
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
        updated_at,
        organization_id
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
        updated_at,
        organization_id
      FROM venue_pr_memberships
      WHERE venue_id = ${venueId}::uuid
        AND id = ${memberId}::uuid
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  // Validates that an organization is actually allowed to work the given venue (linked via
  // organization_venue_links, admin-managed) before it can be stamped onto a PR membership -
  // otherwise any venue owner could tag a PR as working for an arbitrary organization it has
  // no relationship with.
  private async assertOrganizationLinkedToVenue(
    organizationId: string,
    venueId: string,
  ): Promise<void> {
    const org = await this.prisma.organizations.findUnique({
      where: { id: organizationId },
      select: { id: true, is_active: true },
    });
    if (!org || !org.is_active) {
      throw new BadRequestException('Organization not found or inactive');
    }

    const link = await this.prisma.organization_venue_links.findUnique({
      where: {
        organization_id_venue_id: {
          organization_id: organizationId,
          venue_id: venueId,
        },
      },
      select: { id: true },
    });
    if (!link) {
      throw new BadRequestException(
        'This organization is not linked to this venue',
      );
    }
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
        throw new BadRequestException(
          'Il ruolo RESPONSABILE non puo avere un superiore',
        );
      }
      return;
    }

    if (!parent) {
      throw new BadRequestException('Questo ruolo richiede un superiore');
    }

    if (role === 'capo_squadra' && parent.role !== 'responsabile') {
      throw new BadRequestException(
        'CAPO_SQUADRA deve avere un RESPONSABILE sopra di lui',
      );
    }

    if (role === 'pr' && parent.role === 'pr') {
      throw new BadRequestException(
        'PR deve essere assegnato sotto un RESPONSABILE o CAPO_SQUADRA',
      );
    }
  }

  private async buildUniquePrRefCode(
    venueId: string,
    seed: string,
    excludeMemberId?: string,
  ): Promise<string> {
    // The seed (PR name/username) only supplies a short, human-recognizable label prefix -
    // it is never the whole code. A random suffix is always appended (not just on
    // collision) so `?pr=CODE` can't be guessed from someone's name. Retries pick a fresh
    // random suffix rather than an incrementing counter, which would just recreate the same
    // guessability problem (-1, -2, ...).
    const base = this.sanitizePrRefCode(seed).slice(0, 12) || 'PR';
    let attempts = 0;

    while (attempts < 20) {
      const candidate = `${base}-${this.randomRefCodeSuffix()}`;
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
      attempts += 1;
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

  // `getVenue` (existence check) and `resolvePrActorContext` (permission check) don't
  // depend on each other's result, but were always awaited sequentially - every PR-network
  // read paid for 2 round trips even when only allowed to proceed after both succeeded
  // (and paid the same 2 round trips before being rejected, since the permission check
  // itself needs its own query for any non-owner role). Running them concurrently halves
  // that. `allSettled` (not `all`) preserves the original error priority: if both would
  // fail, "venue not found" still wins over "forbidden", matching the previous sequential
  // `await getVenue(); await resolvePrActorContext();` behavior.
  private async getVenueAndPrActorContext(
    venueId: string,
    user?: RequestUser,
    requireManagePermission = false,
  ): Promise<{ owner: boolean; membership: PrMembershipRow | null }> {
    const [venueResult, actorContextResult] = await Promise.allSettled([
      this.getVenue(venueId),
      this.resolvePrActorContext(venueId, user, requireManagePermission),
    ]);
    if (venueResult.status === 'rejected') throw venueResult.reason;
    if (actorContextResult.status === 'rejected')
      throw actorContextResult.reason;
    return actorContextResult.value;
  }

  // Public listing (cached 300s at the controller) - `select` trims Stripe account/payout
  // fields, contract/billing fields, and the bar/bottle price-list JSON blobs, none of
  // which the public list view renders and none of which should be sent to an
  // unauthenticated caller. Full row (incl. those fields, for the owner/admin) is still
  // available via `getVenue(id)`.
  async listVenues() {
    // Safety net against unbounded growth; well above current venue counts so it doesn't
    // change today's response, but caps the worst case as the platform scales.
    return await this.prisma.venues.findMany({
      orderBy: { created_at: 'desc' },
      take: 1000,
      select: {
        id: true,
        name: true,
        city: true,
        address: true,
        description: true,
        image: true,
        latitude: true,
        longitude: true,
        radius_geofence: true,
        created_at: true,
        updated_at: true,
      },
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
      const normalized = this.normalizeBarPriceListInput(
        updates.bar_price_list,
      );
      data.bar_price_list = normalized as Prisma.InputJsonValue;
    }

    if (updates.bottle_price_list !== undefined) {
      const normalized = this.normalizeBottlePriceListInput(
        updates.bottle_price_list,
      );
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
      bottle_price_list: this.normalizeBottlePriceList(
        updated.bottle_price_list,
      ),
    };
  }

  async createVenue(input: {
    name: string;
    city?: string;
    address?: string;
    radius_geofence?: number;
    stripe_account_id?: string;
  }): Promise<venues> {
    if (!input || !input.name) {
      throw new BadRequestException('Missing required fields');
    }

    const data: Prisma.venuesCreateInput = {
      name: input.name,
      city: input.city ?? undefined,
      address: input.address ?? undefined,
    };

    if (input.radius_geofence !== undefined) {
      data.radius_geofence = input.radius_geofence;
    }
    if (input.stripe_account_id !== undefined) {
      data.stripe_account_id = input.stripe_account_id;
    }

    if (input.address) {
      const coords = await geocodeAddress(input.address);
      if (coords) {
        data.latitude = coords.latitude;
        data.longitude = coords.longitude;
      }
    }

    return await this.prisma.venues.create({ data });
  }

  async updateVenue(
    id: string,
    updates: Partial<{
      name?: string;
      city?: string;
      address?: string;
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
    if (updates.address !== undefined) {
      data.address = updates.address;
      if (updates.address) {
        const coords = await geocodeAddress(updates.address);
        if (coords) {
          data.latitude = coords.latitude;
          data.longitude = coords.longitude;
        }
      }
    }

    return await this.prisma.venues.update({ where: { id }, data });
  }

  async updateVenueImage(
    id: string,
    image: string | null | undefined,
  ): Promise<venues> {
    if (image === undefined) {
      throw new BadRequestException('image is required');
    }

    const venue = await this.prisma.venues.findUnique({
      where: { id },
      select: { id: true, image: true },
    });

    if (!venue) {
      throw new NotFoundException('Venue not found');
    }

    const normalizedImage = this.normalizeManagedImagePath(image, 'venues');
    const updatedVenue = await this.prisma.venues.update({
      where: { id },
      data: { image: normalizedImage },
    });

    if (
      venue.image &&
      venue.image !== updatedVenue.image &&
      this.isManagedImagePath(venue.image, 'venues')
    ) {
      void this.storage.deletePublicImage(venue.image).catch(() => undefined);
    }

    return updatedVenue;
  }

  async uploadVenueImage(file?: {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
  }) {
    if (!file) {
      throw new BadRequestException('file is required');
    }
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('file must be an image');
    }

    const ext = (() => {
      const match = /\.(png|jpe?g|webp)$/i.exec(file.originalname || '');
      if (match) return match[1].toLowerCase();
      if (file.mimetype === 'image/png') return 'png';
      if (file.mimetype === 'image/webp') return 'webp';
      return 'jpg';
    })();

    const { pathPromise } = this.storage.uploadPublicImageFromBuffer({
      prefix: 'venues',
      buffer: file.buffer,
      contentType: file.mimetype,
      ext,
    });

    const path = await pathPromise;
    return { path };
  }

  async createVenueImageSignedUpload(params?: {
    ext?: string;
    contentType?: string;
  }) {
    return this.storage.createSignedUploadForPublicImage({
      prefix: 'venues',
      ext: params?.ext,
      contentType: params?.contentType,
    });
  }

  // Per-venue PR season pass branding (Fase 7 "tessere custom" - Apple Wallet only; Google
  // Wallet still has no real integration, see buildPrSeasonPassApplePkpass). A venue without
  // a row here just gets the existing hardcoded dark/gold defaults - this is additive.
  async getVenueWalletTemplate(venueId: string) {
    await this.getVenue(venueId);
    return this.prisma.venue_wallet_templates.findUnique({
      where: { venue_id: venueId },
    });
  }

  async updateVenueWalletTemplate(
    venueId: string,
    dto: {
      background_color?: string | null;
      foreground_color?: string | null;
      label_color?: string | null;
    },
  ) {
    await this.getVenue(venueId);
    return this.prisma.venue_wallet_templates.upsert({
      where: { venue_id: venueId },
      create: {
        venue_id: venueId,
        background_color: dto.background_color ?? null,
        foreground_color: dto.foreground_color ?? null,
        label_color: dto.label_color ?? null,
      },
      update: {
        background_color:
          dto.background_color === undefined ? undefined : dto.background_color,
        foreground_color:
          dto.foreground_color === undefined ? undefined : dto.foreground_color,
        label_color:
          dto.label_color === undefined ? undefined : dto.label_color,
      },
    });
  }

  // Mirrors uploadVenueImage/updateVenueImage's two-step pattern (upload the file, then
  // persist the returned path) - kept as two steps for the same reason: the caller can show
  // a preview before committing, and a failed persist doesn't leave a half-updated record.
  async uploadVenueWalletLogo(file?: {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
  }) {
    if (!file) throw new BadRequestException('file is required');
    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('file must be an image');
    }

    const ext = (() => {
      const match = /\.(png|jpe?g|webp)$/i.exec(file.originalname || '');
      if (match) return match[1].toLowerCase();
      if (file.mimetype === 'image/png') return 'png';
      if (file.mimetype === 'image/webp') return 'webp';
      return 'jpg';
    })();

    const { pathPromise } = this.storage.uploadPublicImageFromBuffer({
      prefix: 'venue-wallet-logos',
      buffer: file.buffer,
      contentType: file.mimetype,
      ext,
    });

    const path = await pathPromise;
    return { path };
  }

  async setVenueWalletLogo(venueId: string, logoPath: string | null) {
    await this.getVenue(venueId);
    const existing = await this.prisma.venue_wallet_templates.findUnique({
      where: { venue_id: venueId },
      select: { logo_path: true },
    });

    const updated = await this.prisma.venue_wallet_templates.upsert({
      where: { venue_id: venueId },
      create: { venue_id: venueId, logo_path: logoPath },
      update: { logo_path: logoPath },
    });

    if (existing?.logo_path && existing.logo_path !== logoPath) {
      void this.storage
        .deletePublicImage(existing.logo_path)
        .catch(() => undefined);
    }

    return updated;
  }

  async deleteVenue(id: string, adminId: string): Promise<venues> {
    const venue = await this.getVenue(id);
    const deleted = await this.prisma.venues.delete({ where: { id } });
    this.auditLog.record({
      adminId,
      action: 'venue.delete',
      targetType: 'venue',
      targetId: id,
      metadata: { name: venue.name },
    });
    return deleted;
  }

  async listEvents(venueId: string): Promise<events[]> {
    return await this.prisma.events.findMany({
      where: { venue_id: venueId },
      orderBy: { date: 'desc' },
    });
  }

  async listPromos(venueId: string): Promise<promos[]> {
    return await this.prisma.promos.findMany({
      where: { venue_id: venueId },
      orderBy: { created_at: 'desc' },
    });
  }

  private normalizeTableBookingPolicy(value: unknown): VenueTableBookingPolicy {
    const raw = String(value ?? '')
      .trim()
      .toLowerCase();
    return raw === 'shared'
      ? VenueTableBookingPolicy.shared
      : VenueTableBookingPolicy.exclusive;
  }

  private async ensureVenueFloorPlan(
    venueId: string,
  ): Promise<venue_floor_plans> {
    const existing = await this.prisma.venue_floor_plans.findUnique({
      where: { venue_id: venueId },
    });
    if (existing) return existing;

    return this.prisma.venue_floor_plans.create({
      data: {
        venue_id: venueId,
      },
    });
  }

  async listVenueTableZones(venueId: string): Promise<venue_table_zones[]> {
    const [, zones] = await Promise.all([
      this.getVenue(venueId),
      this.prisma.venue_table_zones.findMany({
        where: { venue_id: venueId },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
    ]);
    return zones;
  }

  async createVenueTableZone(
    venueId: string,
    body: {
      name: string;
      color?: string;
      per_testa?: number;
      costo_minimo?: number;
      persone_max?: number;
      booking_policy?: 'exclusive' | 'shared';
      sort_order?: number;
      floor_x?: number;
      floor_y?: number;
      floor_w?: number;
      floor_h?: number;
      is_active?: boolean;
    },
  ): Promise<venue_table_zones> {
    await this.getVenue(venueId);

    const name = String(body?.name ?? '').trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }

    const perTesta =
      body?.per_testa === undefined || body?.per_testa === null
        ? null
        : Number(body.per_testa);
    if (perTesta !== null && (!Number.isFinite(perTesta) || perTesta < 0)) {
      throw new BadRequestException('per_testa must be >= 0');
    }

    const costoMinimo =
      body?.costo_minimo === undefined || body?.costo_minimo === null
        ? null
        : Number(body.costo_minimo);
    if (
      costoMinimo !== null &&
      (!Number.isFinite(costoMinimo) || costoMinimo < 0)
    ) {
      throw new BadRequestException('costo_minimo must be >= 0');
    }

    const personeMax =
      body?.persone_max === undefined || body?.persone_max === null
        ? null
        : Number(body.persone_max);
    if (
      personeMax !== null &&
      (!Number.isInteger(personeMax) || personeMax < 1)
    ) {
      throw new BadRequestException('persone_max must be an integer >= 1');
    }

    const sortOrder =
      body?.sort_order !== undefined && body?.sort_order !== null
        ? Number(body.sort_order)
        : await this.prisma.venue_table_zones.count({
            where: { venue_id: venueId },
          });

    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      throw new BadRequestException('sort_order must be an integer >= 0');
    }

    const floorX =
      body?.floor_x === undefined || body?.floor_x === null
        ? null
        : Number(body.floor_x);
    if (floorX !== null && (!Number.isFinite(floorX) || floorX < 0)) {
      throw new BadRequestException('floor_x must be >= 0');
    }

    const floorY =
      body?.floor_y === undefined || body?.floor_y === null
        ? null
        : Number(body.floor_y);
    if (floorY !== null && (!Number.isFinite(floorY) || floorY < 0)) {
      throw new BadRequestException('floor_y must be >= 0');
    }

    const floorW =
      body?.floor_w === undefined || body?.floor_w === null
        ? null
        : Number(body.floor_w);
    if (floorW !== null && (!Number.isFinite(floorW) || floorW <= 0)) {
      throw new BadRequestException('floor_w must be > 0');
    }

    const floorH =
      body?.floor_h === undefined || body?.floor_h === null
        ? null
        : Number(body.floor_h);
    if (floorH !== null && (!Number.isFinite(floorH) || floorH <= 0)) {
      throw new BadRequestException('floor_h must be > 0');
    }

    try {
      return await this.prisma.venue_table_zones.create({
        data: {
          venue_id: venueId,
          name,
          color: body?.color ? String(body.color).trim() : null,
          per_testa: perTesta,
          costo_minimo: costoMinimo,
          persone_max: personeMax,
          booking_policy: this.normalizeTableBookingPolicy(
            body?.booking_policy,
          ),
          sort_order: sortOrder,
          floor_x: floorX,
          floor_y: floorY,
          floor_w: floorW,
          floor_h: floorH,
          is_active:
            body?.is_active === undefined ? true : Boolean(body.is_active),
        },
      });
    } catch (error: unknown) {
      const prismaCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      if (prismaCode === 'P2002') {
        throw new BadRequestException(
          'Zone name already exists for this venue',
        );
      }
      throw error;
    }
  }

  async updateVenueTableZone(
    venueId: string,
    zoneId: string,
    body: {
      name?: string;
      color?: string;
      per_testa?: number | null;
      costo_minimo?: number | null;
      persone_max?: number | null;
      booking_policy?: 'exclusive' | 'shared';
      sort_order?: number;
      floor_x?: number | null;
      floor_y?: number | null;
      floor_w?: number | null;
      floor_h?: number | null;
      is_active?: boolean;
    },
  ): Promise<venue_table_zones> {
    await this.getVenue(venueId);

    const zone = await this.prisma.venue_table_zones.findUnique({
      where: { id: zoneId },
      select: { id: true, venue_id: true },
    });
    if (!zone || zone.venue_id !== venueId) {
      throw new NotFoundException('Zone not found');
    }

    const data: Prisma.venue_table_zonesUpdateInput = {};

    if (body?.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new BadRequestException('name cannot be empty');
      data.name = name;
    }

    if (body?.color !== undefined) {
      const color = String(body.color ?? '').trim();
      data.color = color.length ? color : null;
    }

    if (body?.per_testa !== undefined) {
      if (body.per_testa === null) {
        data.per_testa = null;
      } else {
        const value = Number(body.per_testa);
        if (!Number.isFinite(value) || value < 0) {
          throw new BadRequestException('per_testa must be >= 0');
        }
        data.per_testa = value;
      }
    }

    if (body?.costo_minimo !== undefined) {
      if (body.costo_minimo === null) {
        data.costo_minimo = null;
      } else {
        const value = Number(body.costo_minimo);
        if (!Number.isFinite(value) || value < 0) {
          throw new BadRequestException('costo_minimo must be >= 0');
        }
        data.costo_minimo = value;
      }
    }

    if (body?.persone_max !== undefined) {
      if (body.persone_max === null) {
        data.persone_max = null;
      } else {
        const value = Number(body.persone_max);
        if (!Number.isInteger(value) || value < 1) {
          throw new BadRequestException('persone_max must be an integer >= 1');
        }
        data.persone_max = value;
      }
    }

    if (body?.booking_policy !== undefined) {
      data.booking_policy = this.normalizeTableBookingPolicy(
        body.booking_policy,
      );
    }

    if (body?.sort_order !== undefined) {
      const value = Number(body.sort_order);
      if (!Number.isInteger(value) || value < 0) {
        throw new BadRequestException('sort_order must be an integer >= 0');
      }
      data.sort_order = value;
    }

    if (body?.floor_x !== undefined) {
      if (body.floor_x === null) {
        data.floor_x = null;
      } else {
        const value = Number(body.floor_x);
        if (!Number.isFinite(value) || value < 0) {
          throw new BadRequestException('floor_x must be >= 0');
        }
        data.floor_x = value;
      }
    }

    if (body?.floor_y !== undefined) {
      if (body.floor_y === null) {
        data.floor_y = null;
      } else {
        const value = Number(body.floor_y);
        if (!Number.isFinite(value) || value < 0) {
          throw new BadRequestException('floor_y must be >= 0');
        }
        data.floor_y = value;
      }
    }

    if (body?.floor_w !== undefined) {
      if (body.floor_w === null) {
        data.floor_w = null;
      } else {
        const value = Number(body.floor_w);
        if (!Number.isFinite(value) || value <= 0) {
          throw new BadRequestException('floor_w must be > 0');
        }
        data.floor_w = value;
      }
    }

    if (body?.floor_h !== undefined) {
      if (body.floor_h === null) {
        data.floor_h = null;
      } else {
        const value = Number(body.floor_h);
        if (!Number.isFinite(value) || value <= 0) {
          throw new BadRequestException('floor_h must be > 0');
        }
        data.floor_h = value;
      }
    }

    if (body?.is_active !== undefined) {
      data.is_active = Boolean(body.is_active);
    }

    try {
      return await this.prisma.venue_table_zones.update({
        where: { id: zoneId },
        data,
      });
    } catch (error: unknown) {
      const prismaCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      if (prismaCode === 'P2002') {
        throw new BadRequestException(
          'Zone name already exists for this venue',
        );
      }
      throw error;
    }
  }

  async deleteVenueTableZone(
    venueId: string,
    zoneId: string,
  ): Promise<venue_table_zones> {
    await this.getVenue(venueId);

    const zone = await this.prisma.venue_table_zones.findUnique({
      where: { id: zoneId },
      select: { id: true, venue_id: true },
    });
    if (!zone || zone.venue_id !== venueId) {
      throw new NotFoundException('Zone not found');
    }

    const attachedTables = await this.prisma.venue_tables.count({
      where: { venue_table_zone_id: zoneId },
    });
    if (attachedTables > 0) {
      throw new BadRequestException(
        'Cannot delete zone: tables are still attached to it',
      );
    }

    return this.prisma.venue_table_zones.delete({ where: { id: zoneId } });
  }

  async getVenueFloorPlan(venueId: string): Promise<VenueFloorPlanPayload> {
    // Existence check, floor plan + its landmarks, zones and tables are all independent of
    // each other except for "does the venue exist" - fetched concurrently via `Promise.all`
    // instead of 3 sequential round trips (getVenue, ensureVenueFloorPlan, then the
    // Promise.all of the rest). Plain `Promise.all`, not `$transaction`: a batch
    // `$transaction` holds one connection and runs its queries sequentially over it, which on
    // a remote pooled DB costs ~N query-durations instead of ~1.
    const [venueExists, floorPlanWithLandmarks, zones, tables] =
      await Promise.all([
        this.prisma.venues.findUnique({
          where: { id: venueId },
          select: { id: true },
        }),
        this.prisma.venue_floor_plans.findUnique({
          where: { venue_id: venueId },
          include: {
            landmarks: {
              orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
            },
          },
        }),
        this.prisma.venue_table_zones.findMany({
          where: { venue_id: venueId, is_active: true },
          orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
        }),
        this.prisma.venue_tables.findMany({
          where: { venue_id: venueId },
          orderBy: [
            { layout_order: 'asc' },
            { numero: 'asc' },
            { nome: 'asc' },
          ],
        }),
      ]);

    if (!venueExists) throw new NotFoundException('Venue not found');

    // Floor plan row doesn't exist yet for this venue (first-ever fetch) - create it lazily,
    // same as before. Rare path, only pays an extra round trip when there truly is no row yet.
    const { landmarks, ...floorPlan } = floorPlanWithLandmarks ?? {
      ...(await this.ensureVenueFloorPlan(venueId)),
      landmarks: [] as venue_floor_landmarks[],
    };

    return {
      ...floorPlan,
      landmarks,
      zones,
      tables,
    };
  }

  async updateVenueFloorPlan(
    venueId: string,
    body: {
      background_image?: string | null;
      canvas_width?: number;
      canvas_height?: number;
      grid_size?: number;
      show_grid?: boolean;
    },
  ): Promise<VenueFloorPlanPayload> {
    await this.getVenue(venueId);

    const data: Prisma.venue_floor_plansUpdateInput = {};

    if (body?.background_image !== undefined) {
      const value = String(body.background_image ?? '').trim();
      data.background_image = value.length ? value : null;
    }

    if (body?.canvas_width !== undefined) {
      const value = Number(body.canvas_width);
      if (!Number.isFinite(value) || value <= 0) {
        throw new BadRequestException('canvas_width must be > 0');
      }
      data.canvas_width = value;
    }

    if (body?.canvas_height !== undefined) {
      const value = Number(body.canvas_height);
      if (!Number.isFinite(value) || value <= 0) {
        throw new BadRequestException('canvas_height must be > 0');
      }
      data.canvas_height = value;
    }

    if (body?.grid_size !== undefined) {
      const value = Number(body.grid_size);
      if (!Number.isFinite(value) || value <= 0) {
        throw new BadRequestException('grid_size must be > 0');
      }
      data.grid_size = value;
    }

    if (body?.show_grid !== undefined) {
      data.show_grid = Boolean(body.show_grid);
    }

    await this.prisma.venue_floor_plans.upsert({
      where: { venue_id: venueId },
      create: {
        venue_id: venueId,
        background_image: data.background_image as string | null | undefined,
        canvas_width: (data.canvas_width as number | undefined) ?? 1000,
        canvas_height: (data.canvas_height as number | undefined) ?? 700,
        grid_size: (data.grid_size as number | undefined) ?? 24,
        show_grid: (data.show_grid as boolean | undefined) ?? true,
      },
      update: data,
    });

    return this.getVenueFloorPlan(venueId);
  }

  async createVenueFloorLandmark(
    venueId: string,
    body: {
      type?: 'dj_console';
      label?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      rotation?: number;
      color?: string;
      sort_order?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<venue_floor_landmarks> {
    await this.getVenue(venueId);
    const floorPlan = await this.ensureVenueFloorPlan(venueId);

    const width =
      body?.width === undefined || body?.width === null
        ? 120
        : Number(body.width);
    const height =
      body?.height === undefined || body?.height === null
        ? 48
        : Number(body.height);
    if (!Number.isFinite(width) || width <= 0) {
      throw new BadRequestException('width must be > 0');
    }
    if (!Number.isFinite(height) || height <= 0) {
      throw new BadRequestException('height must be > 0');
    }

    const sortOrder =
      body?.sort_order === undefined || body?.sort_order === null
        ? 0
        : Number(body.sort_order);
    if (!Number.isInteger(sortOrder) || sortOrder < 0) {
      throw new BadRequestException('sort_order must be an integer >= 0');
    }

    return this.prisma.venue_floor_landmarks.create({
      data: {
        floor_plan_id: floorPlan.id,
        type:
          body?.type === 'dj_console'
            ? VenueFloorLandmarkType.dj_console
            : VenueFloorLandmarkType.dj_console,
        label: body?.label ? String(body.label).trim() : null,
        x: body?.x === undefined || body?.x === null ? 0 : Number(body.x),
        y: body?.y === undefined || body?.y === null ? 0 : Number(body.y),
        width,
        height,
        rotation:
          body?.rotation === undefined || body?.rotation === null
            ? 0
            : Number(body.rotation),
        color: body?.color ? String(body.color).trim() : null,
        sort_order: sortOrder,
        metadata:
          body?.metadata && typeof body.metadata === 'object'
            ? (body.metadata as Prisma.InputJsonValue)
            : undefined,
      },
    });
  }

  async updateVenueFloorLandmark(
    venueId: string,
    landmarkId: string,
    body: {
      type?: 'dj_console';
      label?: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      rotation?: number;
      color?: string;
      sort_order?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<venue_floor_landmarks> {
    await this.getVenue(venueId);
    const landmark = await this.prisma.venue_floor_landmarks.findUnique({
      where: { id: landmarkId },
      select: {
        id: true,
        floor_plan: {
          select: {
            venue_id: true,
          },
        },
      },
    });
    if (!landmark || landmark.floor_plan?.venue_id !== venueId) {
      throw new NotFoundException('Landmark not found');
    }

    const data: Prisma.venue_floor_landmarksUpdateInput = {};

    if (body?.type !== undefined) {
      data.type = VenueFloorLandmarkType.dj_console;
    }
    if (body?.label !== undefined) {
      const value = String(body.label ?? '').trim();
      data.label = value.length ? value : null;
    }
    if (body?.x !== undefined) {
      const value = Number(body.x);
      if (!Number.isFinite(value))
        throw new BadRequestException('x must be numeric');
      data.x = value;
    }
    if (body?.y !== undefined) {
      const value = Number(body.y);
      if (!Number.isFinite(value))
        throw new BadRequestException('y must be numeric');
      data.y = value;
    }
    if (body?.width !== undefined) {
      const value = Number(body.width);
      if (!Number.isFinite(value) || value <= 0) {
        throw new BadRequestException('width must be > 0');
      }
      data.width = value;
    }
    if (body?.height !== undefined) {
      const value = Number(body.height);
      if (!Number.isFinite(value) || value <= 0) {
        throw new BadRequestException('height must be > 0');
      }
      data.height = value;
    }
    if (body?.rotation !== undefined) {
      const value = Number(body.rotation);
      if (!Number.isFinite(value)) {
        throw new BadRequestException('rotation must be numeric');
      }
      data.rotation = value;
    }
    if (body?.color !== undefined) {
      const value = String(body.color ?? '').trim();
      data.color = value.length ? value : null;
    }
    if (body?.sort_order !== undefined) {
      const value = Number(body.sort_order);
      if (!Number.isInteger(value) || value < 0) {
        throw new BadRequestException('sort_order must be an integer >= 0');
      }
      data.sort_order = value;
    }
    if (body?.metadata !== undefined) {
      data.metadata =
        body.metadata && typeof body.metadata === 'object'
          ? (body.metadata as Prisma.InputJsonValue)
          : Prisma.DbNull;
    }

    return this.prisma.venue_floor_landmarks.update({
      where: { id: landmarkId },
      data,
    });
  }

  async deleteVenueFloorLandmark(
    venueId: string,
    landmarkId: string,
  ): Promise<venue_floor_landmarks> {
    await this.getVenue(venueId);
    const landmark = await this.prisma.venue_floor_landmarks.findUnique({
      where: { id: landmarkId },
      select: {
        id: true,
        floor_plan: {
          select: {
            venue_id: true,
          },
        },
      },
    });
    if (!landmark || landmark.floor_plan?.venue_id !== venueId) {
      throw new NotFoundException('Landmark not found');
    }

    return this.prisma.venue_floor_landmarks.delete({
      where: { id: landmarkId },
    });
  }

  async createZoneTables(
    venueId: string,
    zoneId: string,
    body: {
      count: number;
      name_prefix?: string;
      start_number?: number;
      columns?: number;
      floor_w?: number;
      floor_h?: number;
      base_x?: number;
      base_y?: number;
      gap_x?: number;
      gap_y?: number;
    },
  ): Promise<venue_tables[]> {
    await this.getVenue(venueId);
    const zone = await this.prisma.venue_table_zones.findUnique({
      where: { id: zoneId },
    });
    if (!zone || zone.venue_id !== venueId) {
      throw new NotFoundException('Zone not found');
    }

    const count = Number(body?.count);
    if (!Number.isInteger(count) || count < 1 || count > 120) {
      throw new BadRequestException(
        'count must be an integer between 1 and 120',
      );
    }

    const columns =
      body?.columns === undefined || body?.columns === null
        ? 4
        : Number(body.columns);
    if (!Number.isInteger(columns) || columns < 1) {
      throw new BadRequestException('columns must be an integer >= 1');
    }

    const floorW =
      body?.floor_w === undefined || body?.floor_w === null
        ? 92
        : Number(body.floor_w);
    const floorH =
      body?.floor_h === undefined || body?.floor_h === null
        ? 56
        : Number(body.floor_h);
    if (!Number.isFinite(floorW) || floorW <= 0) {
      throw new BadRequestException('floor_w must be > 0');
    }
    if (!Number.isFinite(floorH) || floorH <= 0) {
      throw new BadRequestException('floor_h must be > 0');
    }

    const baseX =
      body?.base_x === undefined || body?.base_x === null
        ? 64
        : Number(body.base_x);
    const baseY =
      body?.base_y === undefined || body?.base_y === null
        ? 96
        : Number(body.base_y);
    const gapX =
      body?.gap_x === undefined || body?.gap_x === null
        ? 120
        : Number(body.gap_x);
    const gapY =
      body?.gap_y === undefined || body?.gap_y === null
        ? 92
        : Number(body.gap_y);

    const prefix =
      String(body?.name_prefix ?? '').trim() ||
      String(zone.name || 'Tavolo').trim();

    const stats = await this.prisma.venue_tables.aggregate({
      where: { venue_id: venueId },
      _max: {
        numero: true,
        layout_order: true,
      },
      _count: {
        id: true,
      },
    });

    const startNumber =
      body?.start_number === undefined || body?.start_number === null
        ? (stats._max.numero ?? 0) + 1
        : Number(body.start_number);
    if (!Number.isInteger(startNumber) || startNumber < 1) {
      throw new BadRequestException('start_number must be an integer >= 1');
    }

    const firstLayoutOrder = (stats._max.layout_order ?? 0) + 1;

    const rows: Prisma.venue_tablesCreateManyInput[] = Array.from({
      length: count,
    }).map((_, index) => {
      const row = Math.floor(index / columns);
      const col = index % columns;
      const number = startNumber + index;
      const x = baseX + col * gapX;
      const y = baseY + row * gapY;

      return {
        venue_id: venueId,
        venue_table_zone_id: zone.id,
        nome: `${prefix} ${number}`,
        zona: zone.name,
        numero: number,
        per_testa: zone.per_testa,
        costo_minimo: zone.costo_minimo,
        persone_max: zone.persone_max,
        floor_x: x,
        floor_y: y,
        floor_w: floorW,
        floor_h: floorH,
        floor_shape: 'rectangle',
        floor_rotation: 0,
        layout_order: firstLayoutOrder + index,
        is_hidden: false,
      };
    });

    try {
      await this.prisma.venue_tables.createMany({
        data: rows,
      });
    } catch (error: unknown) {
      const prismaCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      if (prismaCode === 'P2002') {
        throw new BadRequestException(
          'Unable to create tables: one or more table numbers already exist for this venue',
        );
      }
      throw error;
    }

    return this.listVenueTables(venueId);
  }

  async listVenueTables(venueId: string): Promise<venue_tables[]> {
    // Existence check's result isn't otherwise used (only to 404), so it runs alongside the
    // fetch instead of gating it.
    const [, tables] = await Promise.all([
      this.getVenue(venueId),
      this.prisma.venue_tables.findMany({
        where: { venue_id: venueId },
        orderBy: [{ zona: 'asc' }, { nome: 'asc' }],
      }),
    ]);
    return tables;
  }

  async listVenueStations(venueId: string): Promise<venue_stations[]> {
    const [, stations] = await Promise.all([
      this.getVenue(venueId),
      this.prisma.venue_stations.findMany({
        where: { venue_id: venueId },
        orderBy: [{ sort_order: 'asc' }, { name: 'asc' }],
      }),
    ]);
    return stations;
  }

  async listAssignableUsersForPr(
    venueId: string,
    searchRaw: string | undefined,
    user?: RequestUser,
  ) {
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

    // The authorization check is only ever used to throw (its result isn't consulted by the
    // query below), so it runs alongside the query instead of gating it.
    const [, rows] = await Promise.all([
      this.getVenueAndPrActorContext(venueId, user, true),
      normalizedSearch.length >= 2
        ? this.prisma.$queryRaw<AssignableUserRow[]>(Prisma.sql`
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
        `),
    ]);

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
    if (!user?.id) throw new ForbiddenException('Forbidden');

    const appRole = this.normalizeAppRole(user.role);
    if (appRole === 'venue' && (!user.venue_id || user.venue_id !== venueId)) {
      throw new ForbiddenException('Forbidden');
    }

    // Independent of each other - the membership lookup only needs venueId/userId, not
    // the venue row itself, so it runs alongside the existence check instead of after it.
    const [, membership] = await Promise.all([
      this.getVenue(venueId),
      this.loadPrMembershipByUser(venueId, user.id),
    ]);
    const isOwner =
      appRole === 'admin' || (appRole === 'venue' && user.venue_id === venueId);

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

  async getMyPrSeasonPass(
    venueId: string,
    user?: RequestUser,
    options?: { refreshWalletLinks?: boolean },
  ) {
    if (!user?.id) throw new ForbiddenException('Forbidden');

    const appRole = this.normalizeAppRole(user.role);
    if (appRole === 'venue' && (!user.venue_id || user.venue_id !== venueId)) {
      throw new ForbiddenException('Forbidden');
    }

    // `venue` (needed below for wallet links) and the membership lookup don't depend on
    // each other, so they run concurrently instead of sequentially.
    const [venue, membership] = await Promise.all([
      this.getVenue(venueId),
      this.loadPrMembershipByUser(venueId, user.id),
    ]);
    if (!membership || !membership.is_active) {
      throw new ForbiddenException('No active PR membership for this venue');
    }

    const now = new Date();
    const defaultValidity = this.buildDefaultSeasonPassValidity(
      membership.created_at,
    );

    let passRow = await this.loadPrSeasonPassByMembership(
      venueId,
      membership.id,
    );
    if (!passRow) {
      const passId = randomUUID();
      const qrToken = randomUUID();
      const serialNumber = `NH-${venueId.slice(0, 6).toUpperCase()}-${membership.id.slice(0, 6).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
      const initialStatus: PrSeasonPassStatusDb =
        defaultValidity.validUntil.getTime() < now.getTime()
          ? 'expired'
          : 'active';
      const walletLinks = this.buildPrSeasonPassWalletLinks({
        passId,
        venueId,
        membershipId: membership.id,
        userId: membership.user_id,
        qrToken,
        serialNumber,
        validUntil: defaultValidity.validUntil,
      });

      const insertedRows = await this.prisma.$queryRaw<
        PrSeasonPassRow[]
      >(Prisma.sql`
        INSERT INTO venue_pr_membership_passes (
          id,
          venue_id,
          pr_membership_id,
          user_id,
          status,
          valid_from,
          valid_until,
          qr_token,
          serial_number,
          wallet_apple_url,
          wallet_google_url,
          wallet_last_issued_at,
          created_at,
          updated_at
        )
        VALUES (
          ${passId}::uuid,
          ${venueId}::uuid,
          ${membership.id}::uuid,
          ${membership.user_id}::uuid,
          ${initialStatus}::"VenuePrMembershipPassStatus",
          ${defaultValidity.validFrom},
          ${defaultValidity.validUntil},
          ${qrToken},
          ${serialNumber},
          ${walletLinks.apple},
          ${walletLinks.google},
          ${walletLinks.apple || walletLinks.google ? now : null},
          NOW(),
          NOW()
        )
        RETURNING
          id,
          venue_id,
          pr_membership_id,
          user_id,
          status::text AS status,
          valid_from,
          valid_until,
          qr_token,
          serial_number,
          wallet_apple_url,
          wallet_google_url,
          wallet_last_issued_at,
          revoked_at,
          metadata,
          created_at,
          updated_at,
          ${membership.role}::text AS membership_role,
          ${membership.is_active} AS membership_is_active
      `);

      passRow = insertedRows[0] ?? null;
    }

    if (!passRow) {
      throw new BadRequestException('Unable to issue PR season pass');
    }

    const isExpired = passRow.valid_until.getTime() < now.getTime();
    const computedStatus: PrSeasonPassStatusDb = passRow.revoked_at
      ? 'revoked'
      : isExpired
        ? 'expired'
        : 'active';
    const shouldRefreshWalletLinks =
      Boolean(options?.refreshWalletLinks) ||
      !passRow.wallet_apple_url ||
      !passRow.wallet_google_url;

    let nextAppleUrl = passRow.wallet_apple_url;
    let nextGoogleUrl = passRow.wallet_google_url;
    let nextIssuedAt = passRow.wallet_last_issued_at;

    if (shouldRefreshWalletLinks) {
      const links = this.buildPrSeasonPassWalletLinks({
        passId: passRow.id,
        venueId: passRow.venue_id,
        membershipId: passRow.pr_membership_id,
        userId: passRow.user_id,
        qrToken: passRow.qr_token,
        serialNumber: passRow.serial_number,
        validUntil: passRow.valid_until,
      });
      nextAppleUrl = links.apple ?? passRow.wallet_apple_url;
      nextGoogleUrl = links.google ?? passRow.wallet_google_url;
      if (links.apple || links.google) {
        nextIssuedAt = now;
      }
    }

    const shouldUpdateRow =
      (passRow.status !== 'revoked' && passRow.status !== computedStatus) ||
      nextAppleUrl !== passRow.wallet_apple_url ||
      nextGoogleUrl !== passRow.wallet_google_url ||
      nextIssuedAt?.getTime() !== passRow.wallet_last_issued_at?.getTime();

    if (shouldUpdateRow) {
      const updatedRows = await this.prisma.$queryRaw<
        PrSeasonPassRow[]
      >(Prisma.sql`
        UPDATE venue_pr_membership_passes
        SET
          status = ${
            passRow.status === 'revoked' ? 'revoked' : computedStatus
          }::"VenuePrMembershipPassStatus",
          wallet_apple_url = ${nextAppleUrl},
          wallet_google_url = ${nextGoogleUrl},
          wallet_last_issued_at = ${nextIssuedAt},
          updated_at = NOW()
        WHERE id = ${passRow.id}::uuid
        RETURNING
          id,
          venue_id,
          pr_membership_id,
          user_id,
          status::text AS status,
          valid_from,
          valid_until,
          qr_token,
          serial_number,
          wallet_apple_url,
          wallet_google_url,
          wallet_last_issued_at,
          revoked_at,
          metadata,
          created_at,
          updated_at,
          ${membership.role}::text AS membership_role,
          ${membership.is_active} AS membership_is_active
      `);
      passRow = updatedRows[0] ?? passRow;
    }

    return {
      venue_id: venueId,
      venue_name: venue.name,
      membership_id: membership.id,
      pass: this.mapPrSeasonPass(passRow),
      generated_at: now.toISOString(),
    };
  }

  async getPrSeasonPassApplePkpass(passId: string, token?: string) {
    const normalizedPassId = String(passId || '').trim();
    const normalizedToken = String(token || '').trim();

    if (!this.isUuid(normalizedPassId)) {
      throw new BadRequestException('Invalid pass id');
    }
    if (!normalizedToken) {
      throw new ForbiddenException('Invalid pass token');
    }

    const rows = await this.prisma.$queryRaw<
      PrSeasonPassAppleDownloadRow[]
    >(Prisma.sql`
      SELECT
        p.id,
        p.venue_id,
        p.pr_membership_id,
        p.user_id,
        p.status::text AS status,
        p.valid_from,
        p.valid_until,
        p.qr_token,
        p.serial_number,
        p.revoked_at,
        v.name AS venue_name,
        v.city AS venue_city,
        u.name AS user_name,
        u.username AS user_username,
        u.email AS user_email,
        m.role::text AS membership_role,
        m.is_active AS membership_is_active,
        wt.logo_path AS wallet_logo_path,
        wt.background_color AS wallet_background_color,
        wt.foreground_color AS wallet_foreground_color,
        wt.label_color AS wallet_label_color
      FROM venue_pr_membership_passes p
      JOIN venue_pr_memberships m ON m.id = p.pr_membership_id
      JOIN venues v ON v.id = p.venue_id
      JOIN users u ON u.id = p.user_id
      LEFT JOIN venue_wallet_templates wt ON wt.venue_id = p.venue_id
      WHERE p.id = ${normalizedPassId}::uuid
        AND p.qr_token = ${normalizedToken}
      LIMIT 1
    `);

    const row = rows[0] ?? null;
    if (!row) {
      throw new NotFoundException('Pass not found');
    }
    if (!row.membership_is_active) {
      throw new ForbiddenException('Membership is not active');
    }

    const status = this.resolvePrSeasonPassStatus(
      row.status,
      row.valid_until,
      row.revoked_at,
    );
    if (status !== 'ACTIVE') {
      throw new ForbiddenException('Pass is not active');
    }

    const buffer = await this.buildPrSeasonPassApplePkpass(row);
    const safeSerial = row.serial_number
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-');

    return {
      filename: `nighthub-pr-${safeSerial}.pkpass`,
      buffer,
    };
  }

  async listVenuePrNetworkMembers(venueId: string, user?: RequestUser) {
    // `loadPrMemberRows` doesn't depend on the actor-context check (only used afterward to
    // filter `visibleRows`), so it runs alongside it instead of after - same fix as
    // `getPrDashboardStats` (PERFORMANCE_CHANGES.md #24).
    const [actorContext, rows] = await Promise.all([
      this.getVenueAndPrActorContext(venueId, user, false),
      this.loadPrMemberRows(venueId),
    ]);
    const visibleRows =
      !actorContext.owner && actorContext.membership
        ? (() => {
            const allowed = this.collectPrSubtree(
              actorContext.membership.id,
              rows,
            );
            return rows.filter((row) => allowed.has(row.id));
          })()
        : rows;

    return visibleRows.map((row) => this.mapPrMember(row));
  }

  // Supports the venue-side "invite" form: CreateVenuePrMemberDto only accepts a raw
  // `user_id`, so this resolves an id/email/username into one first. Only returns the
  // minimal fields the invite form needs to confirm it found the right person - never the
  // full user row.
  async lookupUserForPrInvite(identifier: string) {
    const value = String(identifier || '').trim();
    if (!value) throw new BadRequestException('identifier is required');

    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      );

    const user = isUuid
      ? await this.prisma.users.findUnique({ where: { id: value } })
      : value.includes('@')
        ? await this.prisma.users.findUnique({
            where: { email: value.toLowerCase() },
          })
        : await this.prisma.users.findUnique({ where: { username: value } });

    if (!user) throw new NotFoundException('User not found');

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
      role: user.role,
    };
  }

  async createVenuePrNetworkMember(
    venueId: string,
    payload: {
      user_id: string;
      role: string;
      parent_membership_id?: string | null;
      ref_code?: string | null;
      organization_id?: string | null;
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

    const existingMembership = await this.loadPrMembershipByUser(
      venueId,
      payload.user_id,
    );
    if (existingMembership) {
      throw new BadRequestException(
        'User already assigned to this venue PR network',
      );
    }

    let resolvedParentId: string | null = payload.parent_membership_id ?? null;

    if (!actorContext.owner) {
      const actorMembership = actorContext.membership;
      if (!actorMembership) throw new ForbiddenException('Forbidden');

      if (!this.canManagerCreatePrRole(actorMembership.role, targetRole)) {
        throw new ForbiddenException('Forbidden');
      }

      if (resolvedParentId && resolvedParentId !== actorMembership.id) {
        throw new ForbiddenException(
          'Puoi assegnare solo membri nel tuo team diretto',
        );
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

    // Only the venue owner (admin, or the venue's own account) can tag a PR as working for
    // an organization - team managers are already restricted to a narrower set of fields
    // above, and letting them freely assign an org here would let them claim a PR works for
    // an organization they have no relationship with.
    let resolvedOrganizationId: string | null = null;
    if (payload.organization_id) {
      if (!actorContext.owner) {
        throw new ForbiddenException(
          'Solo il locale può assegnare un PR a un’organizzazione',
        );
      }
      await this.assertOrganizationLinkedToVenue(
        payload.organization_id,
        venueId,
      );
      resolvedOrganizationId = payload.organization_id;
    }

    const refSeed =
      payload.ref_code?.trim() ||
      targetUser.username ||
      targetUser.name ||
      targetUser.email;
    const refCode = await this.buildUniquePrRefCode(venueId, refSeed);

    const inserted = await this.prisma.$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`
      INSERT INTO venue_pr_memberships (
        venue_id,
        user_id,
        role,
        parent_membership_id,
        ref_code,
        is_active,
        created_by_user_id,
        organization_id,
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
        ${resolvedOrganizationId}::uuid,
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
      organization_id?: string | null;
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

      if (
        existing.parent_membership_id !== actorMembership.id ||
        existing.role !== 'pr'
      ) {
        throw new ForbiddenException(
          'Puoi gestire solo PR diretti del tuo team',
        );
      }

      const onlyToggleActive =
        payload.is_active !== undefined &&
        payload.role === undefined &&
        payload.parent_membership_id === undefined &&
        payload.ref_code === undefined;

      if (!onlyToggleActive) {
        throw new ForbiddenException(
          'Non hai permessi per modificare questi campi',
        );
      }
    }

    let nextRole = existing.role;
    let nextParentId = existing.parent_membership_id;
    let nextIsActive = Boolean(existing.is_active);
    let nextRefCode = existing.ref_code;
    let nextOrganizationId = existing.organization_id;

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

      if (payload.organization_id !== undefined) {
        if (payload.organization_id) {
          await this.assertOrganizationLinkedToVenue(
            payload.organization_id,
            venueId,
          );
        }
        nextOrganizationId = payload.organization_id ?? null;
      }
    }

    if (payload.is_active !== undefined) {
      nextIsActive = Boolean(payload.is_active);
    }

    if (nextParentId && nextParentId === existing.id) {
      throw new BadRequestException(
        'Un membro non puo essere il proprio superiore',
      );
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

    if ((nextOrganizationId ?? null) !== (existing.organization_id ?? null)) {
      updates.push(Prisma.sql`organization_id = ${nextOrganizationId}::uuid`);
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

      if (
        existing.parent_membership_id !== actorMembership.id ||
        existing.role !== 'pr'
      ) {
        throw new ForbiddenException(
          'Puoi eliminare solo PR diretti del tuo team',
        );
      }
    }

    const children = await this.prisma.$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`
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
      const allowed = this.collectPrSubtree(
        actorContext.membership.id,
        treeRows,
      );
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
    // Three independent checks (venue exists, event belongs to this venue, actor has PR
    // access) plus the assignments query itself (which only needs venueId/eventId, not the
    // checks' results - actorContext is only consulted afterward to filter rows) all run
    // concurrently. `allSettled` (not `all`) preserves the original error priority
    // (venue > event > forbidden) for the three checks regardless of which settles first; the
    // rows query's own errors (if any) surface naturally since it isn't wrapped.
    const [venueResult, eventResult, actorContextResult, rows] =
      await Promise.all([
        this.getVenue(venueId).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        ),
        this.ensureEventBelongsToVenue(eventId, venueId).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        ),
        this.resolvePrActorContext(venueId, user, false).then(
          (value) => ({ status: 'fulfilled' as const, value }),
          (reason: unknown) => ({ status: 'rejected' as const, reason }),
        ),
        this.prisma.$queryRaw<PrEventAssignmentRow[]>(Prisma.sql`
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
    `),
      ]);
    if (venueResult.status === 'rejected') throw venueResult.reason;
    if (eventResult.status === 'rejected') throw eventResult.reason;
    if (actorContextResult.status === 'rejected')
      throw actorContextResult.reason;
    const actorContext = actorContextResult.value;

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
      const allowed = this.collectPrSubtree(
        actorContext.membership.id,
        allMembers,
      );
      if (!allowed.has(targetMembership.id)) {
        throw new ForbiddenException('Forbidden');
      }
    }

    const assignmentRows = await this.prisma.$queryRaw<
      Array<{ is_active: boolean }>
    >(
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

    // Prevents scan stats being inflated with guests that don't correspond to real users -
    // guest_user_id, when present, must resolve to an actual account.
    if (payload.guest_user_id) {
      const guestExists = await this.prisma.users.findUnique({
        where: { id: payload.guest_user_id },
        select: { id: true },
      });
      if (!guestExists) {
        throw new BadRequestException('guest_user_id does not exist');
      }
    }

    const metadataJson = payload.metadata
      ? JSON.stringify(payload.metadata)
      : null;
    let rows: PrScanRow[];
    try {
      rows = await this.prisma.$queryRaw<PrScanRow[]>(Prisma.sql`
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
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (
        message.includes('uniq_pr_qr_scan_per_guest') ||
        message.includes('duplicate key value violates unique constraint')
      ) {
        // Idempotent: the same PR already registered a scan for this guest at this event -
        // return that existing row instead of erroring or silently double-counting stats.
        const existing = await this.prisma.$queryRaw<PrScanRow[]>(Prisma.sql`
          SELECT
            id, venue_id, event_id, pr_membership_id, scanned_by_user_id,
            guest_user_id, referral_code, scanned_at, entry_id, entered_at,
            metadata, created_at, updated_at
          FROM venue_pr_qr_scans
          WHERE event_id = ${payload.event_id}::uuid
            AND pr_membership_id = ${targetMembership.id}::uuid
            AND guest_user_id = ${payload.guest_user_id}::uuid
          LIMIT 1
        `);
        if (existing[0]) return this.mapPrScan(existing[0]);
      }
      throw error;
    }

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
    const actorContext = await this.getVenueAndPrActorContext(
      venueId,
      user,
      false,
    );

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
      const allowed = this.collectPrSubtree(
        actorContext.membership.id,
        allMembers,
      );
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
    const gender =
      explicitGender ??
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

    this.evaluateBadges(guestUserId);

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
    const eventId = filters?.event_id ?? undefined;
    // `memberRows` and `scanRows` don't depend on `actorContext`/the event-ownership check at
    // all (they're only filtered by `visibleIds` afterward) - all four run together instead of
    // 3 sequential round trips.
    const [actorContext, , memberRows, scanRows, referralReservationRows] =
      await Promise.all([
        this.getVenueAndPrActorContext(venueId, user, false),
        eventId ? this.ensureEventBelongsToVenue(eventId, venueId) : undefined,
        this.loadPrMemberRows(venueId),
        this.prisma.$queryRaw<
          Array<{
            pr_membership_id: string;
            scans_count: number;
            entries_count: number;
          }>
        >(Prisma.sql`
        SELECT
          pr_membership_id,
          COUNT(*)::int AS scans_count,
          COUNT(entry_id)::int AS entries_count
        FROM venue_pr_qr_scans
        WHERE venue_id = ${venueId}::uuid
          ${eventId ? Prisma.sql`AND event_id = ${eventId}::uuid` : Prisma.empty}
        GROUP BY pr_membership_id
      `),
        // Conversions from the PR's shareable link/code (reservations.meta.pr_membership_id,
        // set in ReservationsService.createReservation once a referral resolves) - previously
        // this dashboard only ever read physical badge scans, so link-driven bookings never
        // showed up here even after they started being attributed correctly.
        this.prisma.$queryRaw<
          Array<{
            pr_membership_id: string;
            referral_reservations_count: number;
          }>
        >(Prisma.sql`
        SELECT
          (r.meta->>'pr_membership_id')::uuid AS pr_membership_id,
          COUNT(*)::int AS referral_reservations_count
        FROM reservations r
        INNER JOIN events e ON e.id = r.event_id
        WHERE e.venue_id = ${venueId}::uuid
          AND r.meta->>'pr_membership_id' IS NOT NULL
          AND r.status <> 'cancelled'
          ${eventId ? Prisma.sql`AND r.event_id = ${eventId}::uuid` : Prisma.empty}
        GROUP BY 1
      `),
      ]);

    let visibleRows = memberRows;
    if (!actorContext.owner && actorContext.membership) {
      const allowed = this.collectPrSubtree(
        actorContext.membership.id,
        memberRows,
      );
      visibleRows = memberRows.filter((row) => allowed.has(row.id));
    }

    if (filters?.membership_id) {
      const target = visibleRows.find(
        (row) => row.id === filters.membership_id,
      );
      if (!target) throw new ForbiddenException('Forbidden');
      visibleRows = [target];
    }

    const visibleIds = new Set(visibleRows.map((row) => row.id));

    const statsByMember = new Map<
      string,
      { scans: number; entries: number; referral_reservations: number }
    >();
    for (const row of scanRows) {
      if (!visibleIds.has(row.pr_membership_id)) continue;
      const existing = statsByMember.get(row.pr_membership_id);
      statsByMember.set(row.pr_membership_id, {
        scans: Number(row.scans_count ?? 0),
        entries: Number(row.entries_count ?? 0),
        referral_reservations: existing?.referral_reservations ?? 0,
      });
    }
    for (const row of referralReservationRows) {
      if (!row.pr_membership_id || !visibleIds.has(row.pr_membership_id)) {
        continue;
      }
      const existing = statsByMember.get(row.pr_membership_id) ?? {
        scans: 0,
        entries: 0,
        referral_reservations: 0,
      };
      existing.referral_reservations = Number(
        row.referral_reservations_count ?? 0,
      );
      statsByMember.set(row.pr_membership_id, existing);
    }

    const childrenMap = new Map<string, string[]>();
    for (const row of visibleRows) {
      if (
        !row.parent_membership_id ||
        !visibleIds.has(row.parent_membership_id)
      ) {
        continue;
      }
      const siblings = childrenMap.get(row.parent_membership_id) ?? [];
      siblings.push(row.id);
      childrenMap.set(row.parent_membership_id, siblings);
    }

    const rollupCache = new Map<
      string,
      { scans: number; entries: number; referral_reservations: number }
    >();
    const rollup = (
      membershipId: string,
    ): { scans: number; entries: number; referral_reservations: number } => {
      const cached = rollupCache.get(membershipId);
      if (cached) return cached;

      const own = statsByMember.get(membershipId) ?? {
        scans: 0,
        entries: 0,
        referral_reservations: 0,
      };
      const children = childrenMap.get(membershipId) ?? [];

      const totals = {
        scans: own.scans,
        entries: own.entries,
        referral_reservations: own.referral_reservations,
      };
      for (const childId of children) {
        const childTotals = rollup(childId);
        totals.scans += childTotals.scans;
        totals.entries += childTotals.entries;
        totals.referral_reservations += childTotals.referral_reservations;
      }

      rollupCache.set(membershipId, totals);
      return totals;
    };

    const members = visibleRows.map((row) => {
      const own = statsByMember.get(row.id) ?? {
        scans: 0,
        entries: 0,
        referral_reservations: 0,
      };
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
          referral_reservations: own.referral_reservations,
        },
        team_stats: {
          scans: team.scans,
          entries: team.entries,
          referral_reservations: team.referral_reservations,
        },
      };
    });

    const totals = members.reduce(
      (acc, member) => {
        acc.scans += member.stats.scans;
        acc.entries += member.stats.entries;
        acc.referral_reservations += member.stats.referral_reservations;
        return acc;
      },
      { scans: 0, entries: 0, referral_reservations: 0 },
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

    const normalized = stations.map((station) => {
      const name = String(station.name || '').trim();
      if (!name) {
        throw new BadRequestException('station name cannot be empty');
      }
      return {
        name,
        station_type: station.station_type as VenueStationType,
        is_active: station.is_active ?? true,
        sort_order: station.sort_order ?? 0,
      };
    });

    // Dedupe by name within the request itself (last one wins, matching the previous
    // sequential-loop behavior) before splitting into create/update, since
    // `@@unique([venue_id, name])` would otherwise reject a batched createMany with
    // duplicate names.
    const byName = new Map<string, (typeof normalized)[number]>();
    for (const payload of normalized)
      byName.set(payload.name.toLowerCase(), payload);
    const deduped = Array.from(byName.values());

    await this.prisma.$transaction(async (tx) => {
      // One lookup for the whole batch instead of one `findFirst` per row.
      const existingRows = await tx.venue_stations.findMany({
        where: { venue_id: venueId },
        select: { id: true, name: true },
      });
      const existingIdByLowerName = new Map(
        existingRows.map((r) => [r.name.toLowerCase(), r.id]),
      );

      const toCreate: (typeof deduped)[number][] = [];
      const toUpdate: { id: string; payload: (typeof deduped)[number] }[] = [];

      for (const payload of deduped) {
        const existingId = existingIdByLowerName.get(
          payload.name.toLowerCase(),
        );
        if (existingId) {
          toUpdate.push({ id: existingId, payload });
        } else {
          toCreate.push(payload);
        }
      }

      if (toCreate.length) {
        await tx.venue_stations.createMany({
          data: toCreate.map((payload) => ({ venue_id: venueId, ...payload })),
        });
      }

      // Each existing station gets different data, so updates still have to be per-row —
      // but they're now independent writes (no interleaved reads) and can run concurrently.
      await Promise.all(
        toUpdate.map(({ id, payload }) =>
          tx.venue_stations.update({ where: { id }, data: payload }),
        ),
      );
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

    if (
      entriesCount + barSalesCount + cloakroomSalesCount + tableSalesCount >
      0
    ) {
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

    // Parse/validate every row up front (was previously interleaved with the writes,
    // one row at a time). This endpoint manages at most one venue_table per zone — a
    // later row targeting the same `zona` overwrites the same underlying row — so, like
    // the stations bulk endpoint, rows sharing a zone are deduped here (last one wins),
    // collapsing what used to be up to 4 sequential queries per *row* into a handful of
    // queries per *distinct zone* instead.
    type ParsedTableRow = {
      zonaRaw: string;
      normalizedNome: string;
      perTesta: number | undefined;
      costoMinimo: number | undefined;
      personeMax: number | undefined;
    };

    const byZone = new Map<string, ParsedTableRow>();

    for (const t of tables) {
      if (!t?.nome || typeof t.nome !== 'string') {
        throw new BadRequestException('Each table must have nome');
      }

      const zonaRaw =
        t.zona === null || t.zona === undefined ? '' : String(t.zona).trim();
      const nomeRaw = String(t.nome).trim();
      const zoneMode = zonaRaw.length > 0;
      const normalizedNome = zoneMode ? nomeRaw || zonaRaw : nomeRaw;

      if (!normalizedNome) {
        throw new BadRequestException('nome cannot be empty');
      }
      if (!zoneMode) {
        throw new BadRequestException('zona is required');
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

      // Map key is case-insensitive to match the zone's unique constraint semantics.
      byZone.set(zonaRaw.toLowerCase(), {
        zonaRaw,
        normalizedNome,
        perTesta,
        costoMinimo,
        personeMax,
      });
    }

    const zoneRows = Array.from(byZone.values());

    await this.prisma.$transaction(async (tx) => {
      const [zoneCountAtStart, existingZones] = await Promise.all([
        tx.venue_table_zones.count({ where: { venue_id: venueId } }),
        tx.venue_table_zones.findMany({
          where: { venue_id: venueId },
          select: { id: true, name: true },
        }),
      ]);
      const existingZoneIdByLowerName = new Map(
        existingZones.map((z) => [z.name.toLowerCase(), z.id]),
      );

      // Only zones that don't exist yet consume a new sort_order slot, counted locally
      // instead of re-querying `count()` after every insert.
      let nextSortOrder = zoneCountAtStart;

      const zoneRecords = await Promise.all(
        zoneRows.map(async (row) => {
          const isNew = !existingZoneIdByLowerName.has(
            row.zonaRaw.toLowerCase(),
          );
          const sortOrder = isNew ? nextSortOrder++ : undefined;

          const zoneRecord = await tx.venue_table_zones.upsert({
            where: { venue_id_name: { venue_id: venueId, name: row.zonaRaw } },
            update: {
              per_testa: row.perTesta ?? null,
              costo_minimo: row.costoMinimo ?? null,
              persone_max: row.personeMax ?? null,
              is_active: true,
            },
            create: {
              venue_id: venueId,
              name: row.zonaRaw,
              per_testa: row.perTesta ?? null,
              costo_minimo: row.costoMinimo ?? null,
              persone_max: row.personeMax ?? null,
              booking_policy: VenueTableBookingPolicy.exclusive,
              sort_order: sortOrder ?? 0,
              is_active: true,
            },
            select: { id: true, name: true },
          });

          return { row, zoneRecord };
        }),
      );

      const zoneIds = zoneRecords.map(({ zoneRecord }) => zoneRecord.id);
      const zoneNames = zoneRecords.map(({ row }) => row.zonaRaw);

      // One lookup for every zone touched by this batch instead of one `findFirst` per row.
      const existingTableRows = await tx.venue_tables.findMany({
        where: {
          venue_id: venueId,
          OR: [
            { venue_table_zone_id: { in: zoneIds } },
            { zona: { in: zoneNames, mode: 'insensitive' } },
          ],
        },
        select: { id: true, venue_table_zone_id: true, zona: true },
      });
      const existingTableIdByZoneId = new Map(
        existingTableRows
          .filter((r) => r.venue_table_zone_id)
          .map((r) => [r.venue_table_zone_id as string, r.id]),
      );
      const existingTableIdByZonaName = new Map(
        existingTableRows.map((r) => [r.zona?.toLowerCase() ?? '', r.id]),
      );

      const toCreate: Prisma.venue_tablesCreateManyInput[] = [];
      const toUpdate: { id: string; data: Prisma.venue_tablesUpdateInput }[] =
        [];

      for (const { row, zoneRecord } of zoneRecords) {
        const existingId =
          existingTableIdByZoneId.get(zoneRecord.id) ??
          existingTableIdByZonaName.get(row.zonaRaw.toLowerCase());

        const data = {
          venue_table_zone_id: zoneRecord.id,
          nome: row.normalizedNome,
          zona: zoneRecord.name,
          numero: null,
          per_testa: row.perTesta,
          costo_minimo: row.costoMinimo,
          persone_max: row.personeMax,
        };

        if (existingId) {
          toUpdate.push({ id: existingId, data });
        } else {
          toCreate.push({ venue_id: venueId, ...data });
        }
      }

      if (toCreate.length) {
        await tx.venue_tables.createMany({ data: toCreate });
      }

      // Different data per row, so still one statement per row - but independent writes
      // that can run concurrently instead of the previous read-then-write-per-row loop.
      await Promise.all(
        toUpdate.map(({ id, data }) =>
          tx.venue_tables.update({ where: { id }, data }),
        ),
      );
    });

    return this.listVenueTables(venueId);
  }

  // venue_tables is purely a floor-plan visual element now (numbered table icon on the
  // map) - it has no FK from reservations/event_tables/sales anymore (those all key off
  // venue_table_zones), so deleting one has no dependent booking/sales data to clean up.
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

    return this.prisma.venue_tables.delete({ where: { id: tableId } });
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
    let zoneIdFromZona: string | undefined;

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

      const zoneSortOrder = await this.prisma.venue_table_zones.count({
        where: { venue_id: venueId },
      });
      const zoneRecord = await this.prisma.venue_table_zones.upsert({
        where: {
          venue_id_name: {
            venue_id: venueId,
            name: trimmed,
          },
        },
        update: {
          is_active: true,
        },
        create: {
          venue_id: venueId,
          name: trimmed,
          booking_policy: VenueTableBookingPolicy.exclusive,
          sort_order: zoneSortOrder,
          is_active: true,
        },
        select: { id: true, name: true },
      });

      zoneIdFromZona = zoneRecord.id;
      data.zona = zoneRecord.name;

      if (!body?.nome) {
        data.nome = zoneRecord.name;
      }
    }

    if (body?.venue_table_zone_id !== undefined) {
      const zoneId =
        body.venue_table_zone_id === null
          ? null
          : String(body.venue_table_zone_id).trim();

      if (!zoneId) {
        data.zone = { disconnect: true };
      } else {
        const zone = await this.prisma.venue_table_zones.findUnique({
          where: { id: zoneId },
          select: { id: true, venue_id: true, name: true },
        });
        if (!zone || zone.venue_id !== venueId) {
          throw new BadRequestException(
            'venue_table_zone_id is invalid for this venue',
          );
        }

        data.zone = { connect: { id: zone.id } };
        if (body?.zona === undefined) {
          data.zona = zone.name;
        }
      }
    } else if (zoneIdFromZona) {
      data.zone = { connect: { id: zoneIdFromZona } };
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

    if (body?.numero !== undefined) {
      if (body.numero === null) {
        data.numero = null;
      } else {
        const v = Number(body.numero);
        if (!Number.isInteger(v) || v < 1) {
          throw new BadRequestException('numero must be an integer >= 1');
        }
        data.numero = v;
      }
    }

    if (body?.per_testa === null) data.per_testa = null;
    if (body?.costo_minimo === null) data.costo_minimo = null;
    if (body?.persone_max === null) data.persone_max = null;

    if (body?.floor_x !== undefined) {
      data.floor_x = body.floor_x === null ? null : Number(body.floor_x);
    }
    if (body?.floor_y !== undefined) {
      data.floor_y = body.floor_y === null ? null : Number(body.floor_y);
    }
    if (body?.floor_w !== undefined) {
      if (body.floor_w === null) {
        data.floor_w = null;
      } else {
        const v = Number(body.floor_w);
        if (!Number.isFinite(v) || v <= 0) {
          throw new BadRequestException('floor_w must be > 0');
        }
        data.floor_w = v;
      }
    }
    if (body?.floor_h !== undefined) {
      if (body.floor_h === null) {
        data.floor_h = null;
      } else {
        const v = Number(body.floor_h);
        if (!Number.isFinite(v) || v <= 0) {
          throw new BadRequestException('floor_h must be > 0');
        }
        data.floor_h = v;
      }
    }
    if (body?.floor_shape !== undefined) {
      const shape = String(body.floor_shape ?? '').trim();
      data.floor_shape = shape.length ? shape : null;
    }
    if (body?.floor_rotation !== undefined) {
      if (body.floor_rotation === null) {
        data.floor_rotation = null;
      } else {
        const v = Number(body.floor_rotation);
        if (!Number.isFinite(v)) {
          throw new BadRequestException('floor_rotation must be numeric');
        }
        data.floor_rotation = v;
      }
    }
    if (body?.layout_order !== undefined && body.layout_order !== null) {
      const v = Number(body.layout_order);
      if (!Number.isInteger(v) || v < 0) {
        throw new BadRequestException('layout_order must be an integer >= 0');
      }
      data.layout_order = v;
    }
    if (body?.is_hidden !== undefined) {
      data.is_hidden = Boolean(body.is_hidden);
    }

    try {
      return await this.prisma.venue_tables.update({
        where: { id: tableId },
        data,
      });
    } catch (error: unknown) {
      const prismaCode =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      if (prismaCode === 'P2002') {
        throw new BadRequestException(
          'Table number already exists for this venue',
        );
      }
      throw error;
    }
  }

  async getStats(venueId: string): Promise<{
    eventsCount: number;
    promosCount: number;
    reservationsCount: number;
    totalReservationAmount: number;
  }> {
    // Plain `Promise.all` (not `$transaction`) so these 4 independent counts run concurrently
    // on separate pooled connections instead of sequentially over one - see
    // PERFORMANCE_CHANGES.md #24 for why a batch `$transaction` doesn't parallelize on a
    // remote pooled DB.
    const [eventsCount, promosCount, reservationsCount, reservationsSum] =
      await Promise.all([
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
    return this.analyticsCache.getOrCompute(
      `analytics-overview:${venueId}:${eventId ?? 'all'}`,
      VenuesService.ANALYTICS_CACHE_TTL_MS,
      () => this.getAnalyticsOverviewUncached(venueId, eventId),
    );
  }

  private async getAnalyticsOverviewUncached(
    venueId: string,
    eventId?: string,
  ) {
    const eventFilter = eventId ? { id: eventId } : { venue_id: venueId };
    const reservationFilter = eventId
      ? { event_id: eventId }
      : { event: { venue_id: venueId } };
    const stayFilter = eventId
      ? { venue_id: venueId, event_id: eventId, duration_ms: { not: null } }
      : { venue_id: venueId, duration_ms: { not: null } };

    // The existence/ownership checks don't gate what the counts below need to run (a bad
    // venueId/eventId just yields zero-row counts, not an error) - they run in the same
    // `Promise.all` instead of sequentially before it, and are validated once everything
    // settles. This also means a cache-warm `getRevenueBreakdown` call below doesn't silently
    // skip validation, since these checks are independent of it.
    const [
      venueRow,
      eventOk,
      eventsCount,
      reservationsCount,
      entriesCount,
      ticketOrdersCount,
      stayAgg,
      revenue,
    ] = await Promise.all([
      this.getVenue(venueId),
      eventId ? this.ensureEventBelongsToVenue(eventId, venueId) : undefined,
      this.prisma.events.count({ where: eventFilter }),
      this.prisma.reservations.count({ where: reservationFilter }),
      this.prisma.entries.count({
        where: eventId
          ? { event_id: eventId }
          : { event: { venue_id: venueId } },
      }),
      this.prisma.ticket_orders.count({
        where: eventId
          ? { event_id: eventId }
          : { event: { venue_id: venueId } },
      }),
      this.prisma.venue_stays.aggregate({
        where: stayFilter,
        _avg: { duration_ms: true },
      }),
      this.getRevenueBreakdown(venueId, eventId),
    ]);
    void venueRow;
    void eventOk;

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
    // Existence/ownership checks run alongside the (possibly cache-warm) analytics fetch
    // instead of gating it - on a cache hit this removes what used to be 1-2 full sequential
    // round trips before returning an already-computed result.
    const [, , analytics] = await Promise.all([
      this.getVenue(venueId),
      eventId ? this.ensureEventBelongsToVenue(eventId, venueId) : undefined,
      this.getAnalytics(venueId),
    ]);
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
      note: 'Le fasce eta sono aggregate a livello venue finche venue_stays/event_presence_events non vengono materializzati per singolo evento.',
    };
  }

  async getRevenueBreakdown(venueId: string, eventId?: string) {
    return this.analyticsCache.getOrCompute(
      `revenue-breakdown:${venueId}:${eventId ?? 'all'}`,
      VenuesService.ANALYTICS_CACHE_TTL_MS,
      () => this.getRevenueBreakdownUncached(venueId, eventId),
    );
  }

  private async getRevenueBreakdownUncached(venueId: string, eventId?: string) {
    const eventIdSql = eventId ?? null;

    // Same reasoning as `getAnalyticsOverviewUncached`: existence/ownership checks run
    // alongside the aggregates instead of gating them, since a bad venueId/eventId here just
    // yields zero-row aggregates rather than an error.
    const [
      venueRow,
      eventOk,
      paidEntryReservationsAgg,
      directEntriesAgg,
      barAgg,
      cloakAgg,
      tableAgg,
      stationRows,
    ] = await Promise.all([
      this.getVenue(venueId),
      eventId ? this.ensureEventBelongsToVenue(eventId, venueId) : undefined,
      this.prisma.reservations.aggregate({
        where: {
          ...(eventId
            ? { event_id: eventId }
            : { event: { venue_id: venueId } }),
          type: ReservationType.entry,
          status: {
            in: [ReservationStatus.confirmed, ReservationStatus.completed],
          },
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
    void venueRow;
    void eventOk;

    const reservationEntryRevenue = this.decimalToNumber(
      paidEntryReservationsAgg._sum.total_amount,
    );
    const directEntryRevenue = this.decimalToNumber(
      directEntriesAgg[0]?.total ?? null,
    );
    const entryRevenue = reservationEntryRevenue + directEntryRevenue;
    const barRevenue = this.decimalToNumber(barAgg._sum.amount);
    const cloakroomRevenue = this.decimalToNumber(cloakAgg._sum.amount);
    const tableRevenue = this.decimalToNumber(tableAgg._sum.pagato_totale);
    const totalRevenue =
      entryRevenue + barRevenue + cloakroomRevenue + tableRevenue;

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
    return this.analyticsCache.getOrCompute(
      `analytics:${venueId}`,
      VenuesService.ANALYTICS_CACHE_TTL_MS,
      () => this.getAnalyticsUncached(venueId),
    );
  }

  private async getAnalyticsUncached(venueId: string) {
    // Every query below only ever needs `venueId` - `entries`/`reservations`/the sales
    // groupBys used to filter by `event_id: { in: eventIds } }`, which forced them to wait
    // for `rawEvents` to resolve first just to get that id list. Filtering through the
    // `event.venue_id` relation instead means they don't need `rawEvents` at all, so every
    // query here (venue existence, the event list, and all the aggregates) runs in a single
    // `Promise.all` instead of 2 sequential round trips. On the rare "brand new venue, zero
    // events" path this wastes a handful of aggregate queries that return empty results - a
    // fine trade for one fewer round trip on every normal call.
    const [
      venue,
      rawEvents,
      entries,
      reservations,
      barTotals,
      cloakTotals,
      tableTotals,
      directEntryRevenueRows,
      stayAggregate,
    ] = await Promise.all([
      this.prisma.venues.findUnique({
        where: { id: venueId },
        select: { id: true, name: true },
      }),
      this.prisma.events.findMany({
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
      }),
      this.prisma.entries.findMany({
        where: { event: { venue_id: venueId } },
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
        where: { event: { venue_id: venueId } },
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
        where: { event: { venue_id: venueId } },
        _sum: { amount: true },
      }),
      this.prisma.cloakroom_sales.groupBy({
        by: ['event_id'],
        where: { event: { venue_id: venueId } },
        _sum: { amount: true },
      }),
      this.prisma.event_tables.groupBy({
        by: ['event_id'],
        where: { event: { venue_id: venueId } },
        _sum: { pagato_totale: true, prenotati: true },
      }),
      this.prisma.$queryRaw<
        Array<{ event_id: string; total: Prisma.Decimal | null }>
      >(
        Prisma.sql`
          SELECT e."event_id", COALESCE(SUM(e."price"), 0) AS total
          FROM "entries" e
          JOIN "events" ev ON ev."id" = e."event_id"
          LEFT JOIN "reservations" r ON r."checkin_entry_id" = e."id"
          WHERE ev."venue_id" = ${venueId}::uuid
            AND (r."id" IS NULL OR r."total_amount" IS NULL)
          GROUP BY e."event_id"
        `,
      ),
      this.prisma.venue_stays.aggregate({
        where: { venue_id: venueId, duration_ms: { not: null } },
        _avg: { duration_ms: true },
      }),
    ]);

    if (!venue) throw new NotFoundException('Venue not found');

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
      if (current)
        current.cloakroomRevenue = this.decimalToNumber(row._sum.amount);
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
      metrics: {
        women: number;
        men: number;
        other: number;
        unknown: number;
      } | null,
      gender?: Gender | null,
    ) => {
      if (gender === Gender.F) {
        if (metrics) metrics.women += 1;
        globalGenderCounts.set(
          'Donna',
          (globalGenderCounts.get('Donna') ?? 0) + 1,
        );
        return;
      }
      if (gender === Gender.M) {
        if (metrics) metrics.men += 1;
        globalGenderCounts.set(
          'Uomo',
          (globalGenderCounts.get('Uomo') ?? 0) + 1,
        );
        return;
      }
      if (gender === Gender.ALTRO) {
        if (metrics) metrics.other += 1;
        globalGenderCounts.set(
          'Altro',
          (globalGenderCounts.get('Altro') ?? 0) + 1,
        );
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
        metrics.hourCounts.set(
          hourLabel,
          (metrics.hourCounts.get(hourLabel) ?? 0) + 1,
        );
        entryHourCounts.set(
          hourLabel,
          (entryHourCounts.get(hourLabel) ?? 0) + 1,
        );
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
        const hourValue =
          entry.created_at.getHours() + entry.created_at.getMinutes() / 60;
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
        ageBucketCounts.set(bucketKey, ageBucketCounts.get(bucketKey) ?? 0);
      }
    }

    for (const reservation of reservations) {
      const metrics = eventMetrics.get(reservation.event_id);
      const meta = eventMeta.get(reservation.event_id);
      if (!metrics || !meta) continue;

      if (reservation.status !== ReservationStatus.cancelled) {
        metrics.totalReservations += 1;

        const eventWeekday = this.weekdayLabels[meta.date.getDay()] ?? 'N/D';
        const bookingWeekday =
          this.weekdayLabels[reservation.created_at.getDay()] ?? 'N/D';
        const bookingHour =
          this.hourLabelFromDate(reservation.created_at) ?? 'N/D';

        bookingByEventWeekday.set(
          eventWeekday,
          (bookingByEventWeekday.get(eventWeekday) ?? 0) + 1,
        );
        bookingByCreatedWeekday.set(
          bookingWeekday,
          (bookingByCreatedWeekday.get(bookingWeekday) ?? 0) + 1,
        );
        bookingByHour.set(
          bookingHour,
          (bookingByHour.get(bookingHour) ?? 0) + 1,
        );

        const leadDaysValue = Math.max(
          0,
          Math.round(
            (this.startOfDay(meta.date).getTime() -
              this.startOfDay(reservation.created_at).getTime()) /
              (1000 * 60 * 60 * 24),
          ),
        );
        leadDays.push(leadDaysValue);

        if (leadDaysValue <= 2)
          leadTimeBuckets.set(
            '0-2 gg',
            (leadTimeBuckets.get('0-2 gg') ?? 0) + 1,
          );
        else if (leadDaysValue <= 7)
          leadTimeBuckets.set(
            '3-7 gg',
            (leadTimeBuckets.get('3-7 gg') ?? 0) + 1,
          );
        else if (leadDaysValue <= 14)
          leadTimeBuckets.set(
            '8-14 gg',
            (leadTimeBuckets.get('8-14 gg') ?? 0) + 1,
          );
        else
          leadTimeBuckets.set(
            '15+ gg',
            (leadTimeBuckets.get('15+ gg') ?? 0) + 1,
          );

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
        metrics.entriesRevenue += this.decimalToNumber(
          reservation.total_amount,
        );
      }
    }

    for (const [eventId, revenue] of entryRevenueMap.entries()) {
      const metrics = eventMetrics.get(eventId);
      if (metrics) metrics.entriesRevenue += revenue;
    }

    const eventSummaries: AnalyticsEventSummary[] = Array.from(
      eventMetrics.values(),
    )
      .map((metrics) => {
        const totalRevenue =
          metrics.entriesRevenue +
          metrics.barRevenue +
          metrics.cloakroomRevenue +
          metrics.tablesRevenue;
        const totalPresences = metrics.totalEntries + metrics.totalTableGuests;
        const topEntryHour =
          this.topCountItem(metrics.hourCounts)?.label ?? null;

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
            totalPresences > 0
              ? this.round(totalRevenue / totalPresences, 2)
              : 0,
          averageAge:
            metrics.ageValues.length > 0
              ? this.average(metrics.ageValues, 1)
              : null,
          topEntryHour,
          women: metrics.women,
          men: metrics.men,
          other: metrics.other,
          unknown: metrics.unknown,
        };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const closedEvents = eventSummaries.filter(
      (event) => event.status === String(EventStatus.CLOSED),
    );
    const comparisonBase =
      closedEvents.length > 0 ? closedEvents : eventSummaries;

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
      const weekday =
        this.weekdayLabels[new Date(event.date).getDay()] ?? 'N/D';
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
            : this.round(
                this.decimalToNumber(stayAggregate._avg.duration_ms) / 60000,
                1,
              ),
      },
      audience: {
        uniqueCustomers,
        repeatCustomers,
        repeatRate:
          uniqueCustomers > 0
            ? this.round((repeatCustomers / uniqueCustomers) * 100, 1)
            : 0,
        averageAge:
          audienceAgeValues.length > 0
            ? this.average(audienceAgeValues, 1)
            : null,
        genderSplit: this.distributionFromMap(
          globalGenderCounts,
          totalGenderCount,
        ),
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
          {
            label: 'Ingressi',
            value: this.round(overviewTotals.entriesRevenue, 2),
          },
          { label: 'Bar', value: this.round(overviewTotals.barRevenue, 2) },
          {
            label: 'Guardaroba',
            value: this.round(overviewTotals.cloakroomRevenue, 2),
          },
          {
            label: 'Tavoli',
            value: this.round(overviewTotals.tablesRevenue, 2),
          },
        ]
          .map((item) => ({
            ...item,
            share:
              overviewTotals.totalRevenue > 0
                ? this.round(
                    (item.value / overviewTotals.totalRevenue) * 100,
                    1,
                  )
                : 0,
          }))
          .sort((a, b) => b.value - a.value),
        averagePerClosedEvent: {
          revenue: this.average(
            comparisonBase.map((event) => event.totalRevenue),
            2,
          ),
          entriesRevenue: this.average(
            comparisonBase.map((event) => event.entriesRevenue),
            2,
          ),
          barRevenue: this.average(
            comparisonBase.map((event) => event.barRevenue),
            2,
          ),
          cloakroomRevenue: this.average(
            comparisonBase.map((event) => event.cloakroomRevenue),
            2,
          ),
          tablesRevenue: this.average(
            comparisonBase.map((event) => event.tablesRevenue),
            2,
          ),
          entries: this.average(
            comparisonBase.map((event) => event.totalEntries),
            1,
          ),
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
          [...eventSummaries].sort(
            (a, b) => b.totalRevenue - a.totalRevenue,
          )[0] ?? null,
      },
      events: eventSummaries,
    };
  }
}
