import { EntryPriceDto, EventPromoDto, TablePricingOverrideDto } from './event-nested.dto';

export class CreateEventDto {
  venue_id?: string;
  name!: string;
  is_featured?: boolean;
  date!: string; // ISO date string (yyyy-mm-dd)
  start_time?: string; // HH:MM or full ISO time
  end_time?: string; // HH:MM or full ISO time
  status?: string; // DRAFT | LIVE | CLOSED
  access_mode?: string; // LIST | PRE_SALE
  presale_price?: number | string;
  presale_currency?: string;
  presale_capacity?: number;

  description?: string;
  image?: string; // URL or data URL (base64)

  // Optional: entry price list rules
  entry_prices?: EntryPriceDto[];

  // Optional: per-event table pricing overrides
  table_pricing?: TablePricingOverrideDto[];

  // Optional: promos to create and link to the event
  promos?: EventPromoDto[];
}
