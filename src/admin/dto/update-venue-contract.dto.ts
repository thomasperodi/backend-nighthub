import {
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class UpdateVenueContractDto {
  @IsOptional()
  @IsDateString()
  contract_start_at?: string | null;

  @IsOptional()
  @IsDateString()
  contract_end_at?: string | null;

  @IsOptional()
  @IsString()
  contract_status?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  contract_monthly_fee?: number | null;

  @IsOptional()
  @IsBoolean()
  contract_auto_renew?: boolean;

  @IsOptional()
  @IsString()
  contract_notes?: string | null;
}
