import { IsString, MinLength } from 'class-validator';

export class ResetPasswordSupabaseDto {
  @IsString()
  access_token: string;

  @IsString()
  @MinLength(6)
  new_password: string;
}
