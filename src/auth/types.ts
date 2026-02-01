export type RequestUser = {
  id: string;
  role: 'client' | 'staff' | 'venue' | 'admin' | string;
  venue_id?: string | null;
};
