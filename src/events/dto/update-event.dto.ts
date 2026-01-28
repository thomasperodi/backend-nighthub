export class UpdateEventDto {
  venue_id?: string;
  name?: string;
  date?: string;
  start_time?: string;
  end_time?: string;
  status?: string;

  description?: string;
  image?: string;

  entry_prices?: Array<{
    label?: string;
    gender?: string;
    start_time?: string;
    end_time?: string;
    price: number | string;
  }>;

  promos?: Array<{
    title: string;
    description?: string;
    discount_type: string;
    discount_value?: number | string;
    status?: string;
  }>;
}
