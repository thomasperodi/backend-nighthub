export class RecordEntryDto {
  event_id?: string;
  staff_id?: string;
  quantity?: number;
  entry_type!: 'male' | 'female' | 'free';
}
