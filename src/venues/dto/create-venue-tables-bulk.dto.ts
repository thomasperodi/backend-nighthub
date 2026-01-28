import { Type } from 'class-transformer';
import { IsArray, ValidateNested } from 'class-validator';
import { CreateVenueTableDto } from './create-venue-table.dto';

export class CreateVenueTablesBulkDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateVenueTableDto)
  tables: CreateVenueTableDto[];
}
