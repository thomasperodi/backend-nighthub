import { IsIn, IsString } from 'class-validator';

export class VoteGroupTableProposalDto {
  @IsString()
  @IsIn(['yes', 'no'])
  vote!: 'yes' | 'no';
}
