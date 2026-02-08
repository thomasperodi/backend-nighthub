import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateGroupDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsArray()
  member_ids?: string[];
}
