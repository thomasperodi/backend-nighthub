import { IsUUID } from 'class-validator';

export class LinkVenueDto {
  @IsUUID()
  venue_id: string;
}
