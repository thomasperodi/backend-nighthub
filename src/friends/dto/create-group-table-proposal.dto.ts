import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateGroupTableProposalDto {
  @IsString()
  venue_id!: string;

  @IsOptional()
  @IsString()
  event_id?: string;

  @IsInt()
  @Min(2)
  guests!: number;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}
