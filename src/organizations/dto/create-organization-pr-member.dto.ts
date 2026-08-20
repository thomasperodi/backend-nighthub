import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export class CreateOrganizationPrMemberDto {
  @IsUUID()
  user_id: string;

  @IsString()
  @IsIn(['RESPONSABILE', 'PR', 'responsabile', 'pr'])
  role: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  parent_membership_id?: string | null;

  @IsOptional()
  @IsString()
  ref_code?: string;
}
