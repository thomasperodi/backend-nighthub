import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class UpdateVenueTableDto {
  @IsOptional()
  @IsString()
  venue_table_zone_id?: string | null;

  @IsOptional()
  @IsString()
  nome?: string;

  @IsOptional()
  @IsString()
  zona?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  numero?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(0)
  per_testa?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  costo_minimo?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  persone_max?: number;

  @IsOptional()
  @IsNumber()
  floor_x?: number | null;

  @IsOptional()
  @IsNumber()
  floor_y?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(1)
  floor_w?: number | null;

  @IsOptional()
  @IsNumber()
  @Min(1)
  floor_h?: number | null;

  @IsOptional()
  @IsString()
  floor_shape?: string | null;

  @IsOptional()
  @IsNumber()
  floor_rotation?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  layout_order?: number;

  @IsOptional()
  @IsBoolean()
  is_hidden?: boolean;
}
