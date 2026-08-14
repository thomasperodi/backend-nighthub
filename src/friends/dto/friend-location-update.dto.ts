import { IsISO8601, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class FriendLocationUpdateDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10000)
  accuracy?: number;

  @IsOptional()
  @IsISO8601()
  timestamp?: string;
}
