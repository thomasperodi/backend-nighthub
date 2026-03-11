export type VenueBarPriceKey =
  | 'water'
  | 'shot'
  | 'coca_cola'
  | 'beer'
  | 'red_bull'
  | 'cocktail'
  | 'premium';

export const DEFAULT_CLOAKROOM_UNIT_PRICE = 3;

export const DEFAULT_BAR_PRICE_LIST: Array<{
  key: VenueBarPriceKey;
  label: string;
  price: number;
}> = [
  { key: 'water', label: 'Acqua', price: 3 },
  { key: 'shot', label: 'Shot', price: 4 },
  { key: 'coca_cola', label: 'Coca Cola', price: 5 },
  { key: 'beer', label: 'Birra', price: 6 },
  { key: 'red_bull', label: 'Red Bull', price: 6 },
  { key: 'cocktail', label: 'Cocktail', price: 10 },
  { key: 'premium', label: 'Premium', price: 12 },
];

export const BAR_PRICE_KEYS = new Set<VenueBarPriceKey>(
  DEFAULT_BAR_PRICE_LIST.map((item) => item.key),
);
