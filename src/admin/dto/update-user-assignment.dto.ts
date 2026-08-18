import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class UpdateUserAssignmentDto {
  @IsIn(['client', 'staff', 'venue', 'admin', 'organization'])
  role: 'client' | 'staff' | 'venue' | 'admin' | 'organization';

  @IsOptional()
  @IsUUID()
  venue_id?: string | null;

  @IsOptional()
  @IsUUID()
  organization_id?: string | null;
}
