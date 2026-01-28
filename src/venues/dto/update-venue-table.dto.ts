import { IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class UpdateVenueTableDto {
  @IsOptional()
  @IsString()
  nome?: string;

  @IsOptional()
  @IsString()
  zona?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  numero?: number;

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
}
