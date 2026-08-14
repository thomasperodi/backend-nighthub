import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class UpdateVenueFloorPlanDto {
  @IsOptional()
  @IsString()
  background_image?: string | null;

  @IsOptional()
  @IsNumber()
  @Min(1)
  canvas_width?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  canvas_height?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  grid_size?: number;

  @IsOptional()
  @IsBoolean()
  show_grid?: boolean;
}
