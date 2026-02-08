import { IsIn, IsOptional, IsString, IsISO8601 } from 'class-validator';

export class VenueStayCheckpointDto {
  @IsString()
  venue_id!: string;

  @IsIn(['enter', 'exit'])
  event_type!: 'enter' | 'exit';

  @IsOptional()
  @IsISO8601()
  timestamp?: string;
}
