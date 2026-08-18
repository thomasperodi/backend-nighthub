import { EntryPriceDto, EventPromoDto, TablePricingOverrideDto } from './event-nested.dto';

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

  entry_prices?: EntryPriceDto[];

  table_pricing?: TablePricingOverrideDto[];

  promos?: EventPromoDto[];
}
