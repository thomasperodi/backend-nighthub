import { IsOptional, IsString } from 'class-validator';

export class UpdateVenueImageDto {
  @IsOptional()
  @IsString()
  image?: string | null;
}
