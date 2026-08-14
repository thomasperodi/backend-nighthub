import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  tagline?: string | null;

  @IsOptional()
  @IsString()
  icon?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthly_price?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  included_events?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  included_people?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  extra_event_price?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  extra_person_price?: number | null;

  @IsOptional()
  @IsBoolean()
  is_custom?: boolean;

  @IsOptional()
  @IsBoolean()
  is_recommended?: boolean;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsInt()
  sort_order?: number;
}
