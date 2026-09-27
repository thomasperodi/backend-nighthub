import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/** POST /pr-network/me/team - the new member always lands under the caller as `pr`. */
export class AddMyTeamMemberDto {
  @IsUUID()
  user_id: string;

  /** Only needed when the caller leads more than one team. */
  @IsOptional()
  @IsUUID()
  membership_id?: string;
}

/** PATCH /pr-network/me/team/:memberId - a responsabile can only (de)activate. */
export class UpdateMyTeamMemberDto {
  @IsBoolean()
  is_active: boolean;

  @IsOptional()
  @IsUUID()
  membership_id?: string;
}
