import {
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Gender } from '@prisma/client';

// Public self-registration always creates a `client` account - there is no `role` or
// `venue_id` field here on purpose. Accepting a client-supplied role previously let anyone
// register directly as `admin`/`staff`/`venue` (see AUTH AUDIT finding B.1). Promoting a
// user to staff/venue/admin is an admin-only operation: PATCH /admin/users/:id/assignment
// (AdminService.updateUserAssignment, guarded by @Roles('admin')).
export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(3)
  username: string;

  @IsString()
  @MinLength(6)
  password: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  // Optional here to match auth.service.ts#register, which only sets `sesso`/`birth_date`
  // when provided (`dto.sesso ?? undefined`). Before the global ValidationPipe was added,
  // these decorators were inert, so registration worked without them; making them required
  // here broke real registration requests that omit them.
  @IsOptional()
  @IsIn(Object.values(Gender))
  sesso?: Gender;

  @IsOptional()
  @IsISO8601()
  birth_date?: string;
}
