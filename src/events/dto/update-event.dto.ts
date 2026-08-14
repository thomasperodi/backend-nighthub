export class UpdateEventDto {
  venue_id?: string;
  name?: string;
  is_featured?: boolean;
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

  table_pricing?: Array<{
    venue_table_zone_id: string;
    per_testa?: number | string;
    costo_minimo?: number | string;
    persone_max?: number;
  }>;

  promos?: Array<{
    title: string;
    description?: string;
    discount_type: string;
    discount_value?: number | string;
    status?: string;
  }>;
}
