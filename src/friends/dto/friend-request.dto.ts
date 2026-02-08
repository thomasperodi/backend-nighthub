import { IsOptional, IsString } from 'class-validator';

export class FriendRequestDto {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  user_id?: string;
}
