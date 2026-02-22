import {
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateAdminVenueDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsNumber()
  @Min(10)
  radius_geofence?: number;

  @IsOptional()
  @IsDateString()
  contract_start_at?: string;

  @IsOptional()
  @IsDateString()
  contract_end_at?: string;

  @IsOptional()
  @IsString()
  contract_status?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  contract_monthly_fee?: number;

  @IsOptional()
  @IsBoolean()
  contract_auto_renew?: boolean;

  @IsOptional()
  @IsString()
  contract_notes?: string;

  @IsOptional()
  @IsUUID()
  manager_user_id?: string;
}
