import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

const BOOKING_POLICIES = ['exclusive', 'shared'] as const;

export class CreateVenueTableZoneDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  per_testa?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  costo_minimo?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  persone_max?: number;

  @IsOptional()
  @IsIn(BOOKING_POLICIES)
  booking_policy?: 'exclusive' | 'shared';

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  floor_x?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  floor_y?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  floor_w?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  floor_h?: number;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
