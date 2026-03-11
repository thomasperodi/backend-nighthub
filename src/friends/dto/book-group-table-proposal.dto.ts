import { IsOptional, IsString, MaxLength } from 'class-validator';

export class BookGroupTableProposalDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  table_name?: string;
}
