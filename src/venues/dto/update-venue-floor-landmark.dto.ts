import {
  IsInt,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

const LANDMARK_TYPES = ['dj_console'] as const;

export class UpdateVenueFloorLandmarkDto {
  @IsOptional()
  @IsIn(LANDMARK_TYPES)
  type?: 'dj_console';

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsNumber()
  x?: number;

  @IsOptional()
  @IsNumber()
  y?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  width?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  height?: number;

  @IsOptional()
  @IsNumber()
  rotation?: number;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
