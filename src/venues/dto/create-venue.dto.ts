import { IsString, IsOptional, IsInt, Min } from 'class-validator';

export class CreateVenueDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsInt()
  @Min(10)
  radius_geofence?: number;

  @IsOptional()
  @IsString()
  stripe_account_id?: string;
}
