import { IsNotEmpty, IsNumber, Min } from 'class-validator';

export class AddTablePaymentDto {
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  amount: number;
}
