import { IsBoolean, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

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

  @IsOptional()
  @IsString()
  @IsIn(['M', 'F', 'ALTRO'])
  gender?: 'M' | 'F' | 'ALTRO';

  @IsOptional()
  @IsBoolean()
  is_complimentary?: boolean;

  @IsOptional()
  @IsString()
  @IsIn([
    'AGE_18_20',
    'AGE_21_24',
    'AGE_25_29',
    'AGE_30_34',
    'AGE_35_PLUS',
    'UNKNOWN',
  ])
  age_bucket?:
    | 'AGE_18_20'
    | 'AGE_21_24'
    | 'AGE_25_29'
    | 'AGE_30_34'
    | 'AGE_35_PLUS'
    | 'UNKNOWN';
}
