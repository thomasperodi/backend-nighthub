import { IsNotEmpty, IsNumber, IsOptional, Min } from 'class-validator';

export class UpdateTableHostessDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  entrati?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  pagato_iniziale?: number;
}
