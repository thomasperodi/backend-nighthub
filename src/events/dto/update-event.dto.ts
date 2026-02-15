export class UpdateEventDto {
  venue_id?: string;
  name?: string;
  date?: string;
  start_time?: string;
  end_time?: string;
  status?: string;
  access_mode?: string;
  presale_price?: number | string | null;
  presale_currency?: string;
  presale_capacity?: number | null;

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
