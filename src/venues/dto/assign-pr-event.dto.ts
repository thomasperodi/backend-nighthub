import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

export class AssignPrEventDto {
  @IsUUID()
  event_id: string;

  @IsUUID()
  pr_membership_id: string;

  @IsOptional()
  @IsBoolean()
  is_active?: boolean;
}
