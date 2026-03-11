import { IsArray, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class VenueBarPriceItemDto {
  @IsString()
  key!: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsNumber()
  @Min(0)
  price!: number;
}

export class UpdateVenuePricingDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  cloakroom_unit_price?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VenueBarPriceItemDto)
  bar_price_list?: VenueBarPriceItemDto[];
}
