import { Type } from 'class-transformer';
import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

// Negotiated overrides on top of the assigned plan's own price/quotas. Required (at least
// monthly_price) when the plan is custom-priced (is_custom, e.g. Elite has no default
// values of its own) - optional on regular plans for one-off exceptions/discounts.
export class VenuePlanCustomTermsDto {
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
  @IsString()
  notes?: string;
}

export class AssignVenuePlanDto {
  @IsOptional()
  @IsUUID()
  plan_id?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => VenuePlanCustomTermsDto)
  custom_terms?: VenuePlanCustomTermsDto;
}
