import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class RegisterPrEntryDto {
  @IsOptional()
  @IsUUID()
  guest_user_id?: string;

  @IsOptional()
  @IsUUID()
  station_id?: string;

  @IsOptional()
  @IsString()
  @IsIn(['male', 'female', 'free'])
  entry_type?: 'male' | 'female' | 'free';
}
