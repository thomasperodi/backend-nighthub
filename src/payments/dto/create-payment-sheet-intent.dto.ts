export class CreatePaymentSheetIntentDto {
  event_id!: string;
  quantity?: number;
  tracking_code?: string;
  ref_code?: string;
  pr_code?: string;
  inviter_user_id?: string;
}
