import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class RecordEntryDto {
  @IsOptional()
  @IsString()
  event_id?: string;

  @IsOptional()
  @IsString()
  staff_id?: string;

  @IsOptional()
  @IsString()
  station_id?: string;

  @IsOptional()
  @IsString()
  user_id?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsIn(['male', 'female', 'free'])
  entry_type?: 'male' | 'female' | 'free';

  @IsOptional()
  @IsIn(['M', 'F', 'ALTRO'])
  gender?: 'M' | 'F' | 'ALTRO';

  @IsOptional()
  @IsBoolean()
  is_complimentary?: boolean;

  @IsOptional()
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
