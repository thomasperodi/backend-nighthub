import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class UpdateUserAssignmentDto {
  @IsIn(['client', 'staff', 'venue', 'admin'])
  role: 'client' | 'staff' | 'venue' | 'admin';

  @IsOptional()
  @IsUUID()
  venue_id?: string | null;
}
