import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

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

  @IsIn(['male', 'female', 'free'])
  entry_type!: 'male' | 'female' | 'free';
}
