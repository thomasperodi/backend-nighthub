import { IsString } from 'class-validator';

export class PushTokenDto {
  @IsString()
  push_token!: string;
}
