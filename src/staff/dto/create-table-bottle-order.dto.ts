import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateTableBottleOrderDto {
  @IsOptional()
  @IsString()
  bottle_key?: string;

  @IsOptional()
  @IsString()
  bottle_name!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  unit_price!: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsBoolean()
  auto_settle?: boolean;

  @IsOptional()
  @IsString()
  station_id?: string;
}