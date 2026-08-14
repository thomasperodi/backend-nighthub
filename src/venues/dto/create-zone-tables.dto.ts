import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateZoneTablesDto {
  @IsInt()
  @Min(1)
  @Max(120)
  count: number;

  @IsOptional()
  @IsString()
  name_prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  start_number?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  columns?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  floor_w?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  floor_h?: number;

  @IsOptional()
  @IsNumber()
  base_x?: number;

  @IsOptional()
  @IsNumber()
  base_y?: number;

  @IsOptional()
  @IsNumber()
  gap_x?: number;

  @IsOptional()
  @IsNumber()
  gap_y?: number;
}
