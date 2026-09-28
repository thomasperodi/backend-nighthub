import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  name?: string | null;

  @IsOptional()
  @IsString()
  phone?: string | null;

  @IsOptional()
  @IsString()
  avatar?: string | null;

  /** Privacy: se false gli amici non vedono a quali serate sei in lista. */
  @IsOptional()
  @IsBoolean()
  nights_visible_to_friends?: boolean;
}
