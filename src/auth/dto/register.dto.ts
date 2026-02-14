import { IsEmail, IsIn, IsISO8601, IsOptional, IsString, MinLength } from 'class-validator';
import { Gender } from '@prisma/client';

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
  role: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  @IsIn(Object.values(Gender))
  sesso: Gender;

  @IsISO8601()
  birth_date: string;

  @IsOptional()
  @IsString()
  venue_id?: string;
}
