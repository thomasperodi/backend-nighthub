import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export class CreateOrganizationPrMemberDto {
  // Which of the organization's linked venues this PR will work at - required, since
  // (unlike a venue account) an organization can be linked to several.
  @IsUUID()
  venue_id: string;

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
