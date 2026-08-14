import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreatePlanDto {
  @IsString()
  key: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  tagline?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthly_price?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  included_events?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  included_people?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  extra_event_price?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  extra_person_price?: number;

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
