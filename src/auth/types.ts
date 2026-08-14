export type RequestUser = {
  id: string;
  role: 'client' | 'staff' | 'venue' | 'admin' | string;
  venue_id?: string | null;
};

// Shape signed into the access token by AuthService (login/refresh). Deliberately minimal -
// no email, no password, nothing sensitive - see AUTH AUDIT.
export type AccessTokenPayload = {
  sub: string;
  role: string;
  venue_id: string | null;
};
