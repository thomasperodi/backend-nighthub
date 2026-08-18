import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  name?: string;

  @IsOptional()
  @IsString()
  vat_number?: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
