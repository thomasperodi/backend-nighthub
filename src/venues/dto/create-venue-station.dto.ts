import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateVenueStationDto {
  @IsString()
  name: string;

  @IsIn(['entry', 'cloakroom', 'bar', 'table'])
  station_type: 'entry' | 'cloakroom' | 'bar' | 'table';

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sort_order?: number;
}