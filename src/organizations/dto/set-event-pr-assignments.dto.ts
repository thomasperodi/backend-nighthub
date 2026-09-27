import { IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';

/** PUT /organizations/:id/events/:eventId/pr-assignments - either the complete set of
 * assigned memberships, or `all_active: true` to assign every active PR. */
export class SetEventPrAssignmentsDto {
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  membership_ids?: string[];

  @IsOptional()
  @IsBoolean()
  all_active?: boolean;
}
