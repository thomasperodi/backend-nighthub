import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import { CreateVenueStationDto } from './create-venue-station.dto';

export class CreateVenueStationsBulkDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVenueStationDto)
  stations: CreateVenueStationDto[];
}