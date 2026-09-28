import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const DISCOUNT_TYPES = ['percentage', 'fixed', 'free'] as const;
export const PROMO_STATUSES = ['active', 'inactive', 'expired'] as const;

/**
 * Who gets the "Nuova promo" push when a promo is created:
 * - recent: people who entered this venue in the last 4 weeks
 * - lapsed: people who have been here, but not in the last 4 weeks
 * - all: every NightHub client (any city, any venue) - use sparingly
 * - none: no push, the promo only shows on the event/venue
 */
export const PROMO_AUDIENCES = ['recent', 'lapsed', 'all', 'none'] as const;
export type PromoAudience = (typeof PROMO_AUDIENCES)[number];

export class CreatePromoDto {
  @IsString()
  @Length(2, 80)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsIn(DISCOUNT_TYPES)
  discount_type!: (typeof DISCOUNT_TYPES)[number];

  /** percentage: 1-100; fixed: euro amount > 0; free: ignored. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000)
  discount_value?: number;

  /** The night it applies to. Required for an organization (it only manages its own nights). */
  @IsOptional()
  @IsUUID()
  event_id?: string;

  /** Admin only (venue and organization accounts get it from their venue / the event). */
  @IsOptional()
  @IsUUID()
  venue_id?: string;

  @IsOptional()
  @IsIn(PROMO_AUDIENCES)
  audience?: PromoAudience;
}

export class UpdatePromoDto {
  @IsOptional()
  @IsString()
  @Length(2, 80)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsIn(DISCOUNT_TYPES)
  discount_type?: (typeof DISCOUNT_TYPES)[number];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000)
  discount_value?: number | null;

  @IsOptional()
  @IsIn(PROMO_STATUSES)
  status?: (typeof PROMO_STATUSES)[number];
}
