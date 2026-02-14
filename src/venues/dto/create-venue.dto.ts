import { IsString, IsOptional, IsInt, Min } from 'class-validator';

export class CreateVenueDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsInt()
  @Min(10)
  radius_geofence?: number;
}
