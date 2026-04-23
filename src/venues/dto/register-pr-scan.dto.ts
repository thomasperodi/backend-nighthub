import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';

export class RegisterPrScanDto {
  @IsUUID()
  event_id: string;

  @IsOptional()
  @IsUUID()
  pr_membership_id?: string;

  @IsOptional()
  @IsString()
  ref_code?: string;

  @IsOptional()
  @IsUUID()
  guest_user_id?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
