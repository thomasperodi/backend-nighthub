import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';

export class CreateVenuePrMemberDto {
  @IsUUID()
  user_id: string;

  @IsString()
  @IsIn([
    'RESPONSABILE',
    'CAPO_SQUADRA',
    'PR',
    'responsabile',
    'capo_squadra',
    'pr',
  ])
  role: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  parent_membership_id?: string | null;

  @IsOptional()
  @IsString()
  ref_code?: string;
}
