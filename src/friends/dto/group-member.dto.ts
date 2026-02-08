import { IsString } from 'class-validator';

export class GroupMemberDto {
  @IsString()
  user_id!: string;
}
