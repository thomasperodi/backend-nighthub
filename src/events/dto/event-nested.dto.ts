// Shared shapes for CreateEventDto/UpdateEventDto's nested array fields. Extracted from
// inline anonymous object types into named classes so the @nestjs/swagger CLI plugin (which
// introspects DTOs to build the OpenAPI schema used to generate the frontend's typed client,
// see pwa/nighthub's `npm run generate:api-types`) can produce a stable, non-circular schema
// for them. No validation/behavior change — these DTOs still have no class-validator
// decorators, matching the rest of this file (see bootstrap.ts's ValidationPipe comment).
export class EntryPriceDto {
  label?: string;
  gender?: string; // M | F | ALTRO
  start_time?: string; // HH:MM or HH:MM:SS
  end_time?: string; // HH:MM or HH:MM:SS
  price!: number | string;
}

export class TablePricingOverrideDto {
  venue_table_zone_id!: string;
  per_testa?: number | string;
  costo_minimo?: number | string;
  persone_max?: number;
}

export class EventPromoDto {
  title!: string;
  description?: string;
  discount_type!: string; // percentage | fixed | free
  discount_value?: number | string;
  status?: string; // active | inactive | expired
}
