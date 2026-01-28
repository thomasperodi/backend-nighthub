export class CreateEventDto {
  venue_id?: string;
  name!: string;
  date!: string; // ISO date string (yyyy-mm-dd)
  start_time?: string; // HH:MM or full ISO time
  end_time?: string; // HH:MM or full ISO time
  status?: string; // DRAFT | LIVE | CLOSED

  description?: string;
  image?: string; // URL or data URL (base64)

  // Optional: entry price list rules
  entry_prices?: Array<{
    label?: string;
    gender?: string; // M | F | ALTRO
    start_time?: string; // HH:MM or HH:MM:SS
    end_time?: string; // HH:MM or HH:MM:SS
    price: number | string;
  }>;

  // Optional: promos to create and link to the event
  promos?: Array<{
    title: string;
    description?: string;
    discount_type: string; // percentage | fixed | free
    discount_value?: number | string;
    status?: string; // active | inactive | expired
  }>;
}
