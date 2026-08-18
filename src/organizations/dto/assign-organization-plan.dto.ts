import { IsOptional, IsUUID, ValidateIf } from 'class-validator';

export class AssignOrganizationPlanDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  plan_id?: string | null;
}
