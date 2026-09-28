import { IsIn, IsOptional, IsString, IsISO8601 } from 'class-validator';

export class VenueStayCheckpointDto {
  @IsString()
  venue_id!: string;

  @IsOptional()
  @IsString()
  event_id?: string;

  @IsIn(['enter', 'exit'])
  event_type!: 'enter' | 'exit';

  @IsOptional()
  @IsISO8601()
  timestamp?: string;

  /** How the app detected the exit (see venue_stays.exit_source). Default 'app'. */
  @IsOptional()
  @IsIn(['geofence', 'app'])
  exit_source?: 'geofence' | 'app';
}
