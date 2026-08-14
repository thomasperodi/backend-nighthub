import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class RecordSaleDto {
  @IsOptional()
  @IsString()
  event_id?: string;

  @IsOptional()
  @IsString()
  event_table_id?: string;

  @IsOptional()
  @IsString()
  staff_id?: string;

  @IsOptional()
  @IsString()
  station_id?: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  amount!: number;
}
