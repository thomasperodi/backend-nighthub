import { IsBoolean } from 'class-validator';

export class FriendLocationSharingDto {
  @IsBoolean()
  enabled!: boolean;
}
