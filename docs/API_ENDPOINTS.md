# NightHub Backend — Riferimento endpoint per il frontend

> Generato il 2026-09-26 leggendo direttamente controller e service in `src/`. Per i **body di richiesta** la fonte autorevole resta l'OpenAPI (`GET /api/docs-json`, usato da `npm run generate:api-types`). Le **risposte** invece NON sono tipizzate nell'OpenAPI (nessun response DTO): le forme qui sotto sono ricavate dal codice dei service e sono la fonte da usare per tipizzare le risposte lato frontend.

---

## 0. Convenzioni globali (leggere prima)

| Tema | Regola |
|---|---|
| Prefisso | Tutte le rotte sono sotto `/api` (es. `POST /api/auth/login`). Nelle tabelle il prefisso è omesso. |
| Auth | `Authorization: Bearer <access_token>` su tutte le rotte **tranne** quelle marcate 🌐 (pubbliche). Access token ~15 min, da tenere **solo in memoria**. |
| Refresh token | Solo cookie httpOnly `nighthub_refresh_token`, path `/api/auth`. Il frontend deve chiamare `/auth/*` con `credentials: 'include'`. Mai nel body. |
| CSRF | `/auth/refresh`, `/auth/logout`, `/auth/sessions*` controllano l'header `Origin` (allow-list). |
| Ruoli | `client` · `staff` · `venue` · `admin` · `organization`. "PR" **non** è un ruolo del JWT: è un overlay (`user.role === 'pr'` nel payload di `/auth/*` e `/users/me`, derivato da una membership PR attiva). |
| Errori | Sempre `{ statusCode: number, message: string \| string[], error?: string, requestId: string }`. `message` è un **array** per errori di validazione (ValidationPipe). 500 → `message: "Internal server error"`. |
| Date | `DateTime` → stringa ISO. **Eccezione eventi serializzati** (`/events*`, `/venues/:id/events`): `date` = `"YYYY-MM-DD"`, `start_time`/`end_time` = `"HH:MM"` (o assenti). Negli oggetti evento *annidati* (es. dentro una reservation) `date` è ISO completo e `start_time` è `"1970-01-01THH:MM:00.000Z"`. |
| ⚠️ Decimal | I campi Prisma `Decimal` restituiti **raw** arrivano come **stringa** (es. `"25.00"`). Sono convertiti in `number` solo dove indicato. Tipizzarli come `string \| number` e fare `Number(x)` dove servono calcoli. Campi tipicamente raw: `venue_table_zones.per_testa/costo_minimo/floor_*`, `venue_tables.*` numerici decimali, `reservations.total_amount`, `promos.discount_value` (tranne negli endpoint evento), `venues.latitude/longitude/cloakroom_unit_price/contract_monthly_fee` (tranne dove serializzati), `entries.price`, `*_sales.amount`, `event_tables.pagato_totale`, `venue_floor_plans.*` in `/venues/:id/floor-plan`. |
| Paginazione | Dove supportata (`?page=&pageSize=`): `{ data: T[], total: number, page: number, pageSize: number, hasMore: boolean }`. Senza quei parametri → array semplice. |
| Upload file | `multipart/form-data`, campo `file`. Upload diretto preferito: gli endpoint `.../signed` restituiscono `{ bucket, path, token, signedUrl }` (Supabase Storage); poi si salva il `path`. |
| Cron 🕒 | Endpoint marcati 🕒 sono per scheduler (secret `CRON_SECRET`), **non** da chiamare dal frontend. |

### Enum (valori esatti)

```ts
type UserRole = 'client' | 'staff' | 'venue' | 'admin' | 'organization';
type EventStatus = 'DRAFT' | 'LIVE' | 'CLOSED' | 'CANCELLED';
type EventAccessMode = 'LIST' | 'PRE_SALE';
type ReservationType = 'table' | 'entry';
type ReservationStatus = 'pending' | 'confirmed' | 'cancelled' | 'completed';
type Gender = 'M' | 'F' | 'ALTRO';
type AgeBucket = 'AGE_18_20' | 'AGE_21_24' | 'AGE_25_29' | 'AGE_30_34' | 'AGE_35_PLUS' | 'UNKNOWN';
type PromoStatus = 'active' | 'inactive' | 'expired';
type DiscountType = 'percentage' | 'fixed' | 'free';
type VenueStationType = 'entry' | 'cloakroom' | 'bar' | 'table';
type BookingPolicy = 'exclusive' | 'shared';
type BottleOrderStatus = 'requested' | 'preparing' | 'delivered';
type FriendRequestStatus = 'pending' | 'accepted' | 'rejected';
type GroupProposalStatus = 'voting' | 'ready' | 'booked' | 'cancelled';
type GroupProposalVote = 'yes' | 'no' | 'pending';
type PrRoleApi = 'RESPONSABILE' | 'PR';        // in uscita: MAIUSCOLO
// in ingresso (create/update PR member) il campo role accetta 'responsabile' | 'pr' (case-insensitive)
type ContentReportStatus = 'pending' | 'resolved' | 'dismissed';
type BadgeRarity = 'COMMON' | 'RARE' | 'EPIC' | 'LEGENDARY' | 'EXCLUSIVE';
type BadgeCategory = 'NIGHTLIFE' | 'EXPLORATION' | 'SOCIAL' | 'SQUAD' | 'TABLES_VIP' | 'STREAK' | 'NIGHT_CHALLENGES' | 'SPECIAL_EVENTS' | 'MILESTONE' | 'SECRET';
```

---

## 1. Tipi condivisi (risposte)

```ts
// Restituito da /auth/register, /auth/login, /auth/refresh
type PublicUser = {
  id: string; email: string; username: string | null; name: string | null; avatar: string | null;
  role: UserRole | 'pr';          // 'pr' se ha una membership PR attiva
  venue_id: string | null; organization_id: string | null;
  pr_venue_id: string | null;     // venue "di atterraggio" del PR
  is_verified_pr: boolean; onboarding_completed: boolean; created_at: string;
};
type AuthSession = { access_token: string; user: PublicUser };

// Restituito da GET/PATCH /users/me  (NB: diverso da PublicUser: ha phone/updated_at, NON ha organization_id)
type MeUser = {
  id: string; email: string; username: string | null; role: UserRole | 'pr';
  name: string | null; phone: string | null; avatar: string | null;
  venue_id: string | null; pr_venue_id: string | null;
  is_verified_pr: boolean; onboarding_completed: boolean; created_at: string; updated_at: string;
};

type Success = { success: true };
type SignedUpload = { bucket: string; path: string; token: string; signedUrl: string };
type UploadedPath = { path: string };

// Evento in lista (/events, /venues/:id/events)
type EventListItem = {
  id: string; venue_id: string; venue: { id: string; name: string; image: string | null };
  name: string; description: string | null; image: string | null; is_featured: boolean;
  date: string /* YYYY-MM-DD */; start_time?: string /* HH:MM */; end_time?: string;
  status: EventStatus;            // calcolato (LIVE/CLOSED dalla finestra oraria)
  created_at: string; updated_at: string;
  promos: PromoPublic[];          // max 3 attive, discount_value: number
};

// Evento dettaglio (GET /events/:id e risposta di create/update)
type EventDetail = {
  // tutte le colonne di events:
  id: string; venue_id: string; organization_id: string | null; name: string; description: string | null;
  image: string | null; is_featured: boolean; featured_source: 'manual' | 'auto' | null;
  date: string; start_time?: string; end_time?: string; status: EventStatus;
  access_mode: EventAccessMode; presale_price: number | null; presale_currency: string;
  presale_capacity: number | null; presale_sold: number; created_at: string; updated_at: string;
  venue: { id; name; city; address; description; image; latitude: number | null; longitude: number | null;
           radius_geofence: number; cloakroom_unit_price: number | null; bar_price_list: any; bottle_price_list: any;
           created_at; updated_at };
  promos: Promo[];                // TUTTE le promo dell'evento (qualsiasi status), discount_value: number
  entry_prices: { id; event_id; label: string | null; gender: Gender | null; start_time?: string; end_time?: string; price: number; created_at }[];
  table_pricing: {
    event_table_id?: string; venue_table_zone_id: string; nome: string; label: string;
    per_testa: number; costo_minimo: number; persone_max: number | null;
    base_per_testa: number; base_costo_minimo: number;
    override_per_testa: number; override_costo_minimo: number; override_persone_max: number | null;
    has_override: boolean;
  }[];
  floor_plan: null | {
    id; venue_id; background_image: string | null; canvas_width: number; canvas_height: number;
    grid_size: number; show_grid: boolean;
    landmarks: { id; type: 'dj_console'; label; x: number; y: number; width: number; height: number; rotation: number; color; metadata; sort_order }[];
    tables: { id /* = zone id */; event_table_id?: string; venue_table_zone_id; zone_name; booking_policy: BookingPolicy;
              zone_color: string | null; nome; per_testa: number; costo_minimo: number; persone_max: number | null;
              has_override: boolean; floor_x: number | null; floor_y: number | null; floor_w: number | null; floor_h: number | null;
              layout_order: number }[];
  };
};

type Promo = { id; venue_id; event_id: string | null; title; description: string | null;
  discount_type: DiscountType; discount_value: string | number | null; status: PromoStatus; created_at: string };

type EventStats = { event_id: string; total_entries: number; total_entries_revenue: number;
  total_bar: number; total_cloakroom: number; total_tables: number; last_updated: string };

// Reservation completa (get, create, update, cancel, checkin, lista paginata)
type Reservation = {
  id; user_id: string | null; event_id; venue_table_zone_id: string | null; table_name: string | null;
  meta: any; type: ReservationType; status: ReservationStatus; guests: number; actual_guests: number | null;
  total_amount: string | null /* Decimal raw */; qr_token: string | null; qr_payload: string | null;
  guest_token: string | null; checked_in_at: string | null; checked_in_by_staff_id: string | null;
  checkin_entry_id: string | null; created_at: string;
  user: { id; name; email; phone } | null;
  event: { id; venue_id; name; date /* ISO */; start_time; end_time;
           venue: { id; name; city; address; latitude; longitude; image } } | null;
  venue_table_zone: { id; venue_id; name; per_testa; costo_minimo; persone_max; booking_policy } | null;
};
// NB: GET /reservations SENZA page/pageSize restituisce righe con le stesse chiavi ma idratate in batch
// (user/event/zone caricati a parte) → stessa forma, trattarle come Reservation.

type PrMember = {
  id; venue_id: string | null; user_id; role: PrRoleApi; parent_membership_id: string | null; ref_code: string;
  is_active: boolean; created_by_user_id: string | null; created_at; updated_at;
  user: { id; name; username; email; role: string }; display_name: string;
  organization_id: string | null; organization: { id; name } | null;
};
```

---

## 2. App / redirect

| Metodo | Path | Ruoli | Ritorna |
|---|---|---|---|
| GET | `/` 🌐 | — | stringa |
| GET | `/health` 🌐 | — | `{ status: 'ok' }` |
| GET | `/api/r/event/:eventId` 🌐 | — | 301 verso `/r/event/:eventId` (sotto, fuori da `/api`), query preservata. |

**Fuori dal prefisso `/api`** (`src/public-web`, alla radice del dominio):

| Metodo | Path | Ritorna |
|---|---|---|
| GET | `/.well-known/apple-app-site-association` 🌐 | JSON per gli universal link iOS (`/r/event/*` apre l'app `4S4XRSW6AC.com.thomas88.nighthub`; override con env `IOS_APP_IDS`). |
| GET | `/r/event/:eventId?pr=` 🌐 | **HTML**: link condivisibile di una serata. App installata → iOS apre l'app direttamente. Altrimenti anteprima (Open Graph per WhatsApp/Instagram) + bottone App Store; Android "in arrivo" finché non c'è `EXPO_PUBLIC_PLAY_STORE_URL`. 404 se l'evento non esiste. |
| GET | `/legal/privacy`, `/legal/termini` 🌐 | **HTML**: informativa privacy e termini (bozze da far rivedere a un legale). |

## 3. Auth (`/auth`)

| Metodo | Path | Ruoli | Body | Ritorna |
|---|---|---|---|---|
| POST | `/auth/register` 🌐 (5/min) | — | `{ email, username, password, name, phone?, avatar?, sesso?: Gender, birth_date?: ISO }` | `AuthSession` + set cookie |
| GET | `/auth/username-available?username=` 🌐 (30/min) | — | — | `{ available: boolean }` (case-insensitive; `false` se < 3 caratteri). `/auth/register` rifiuta con 409 `User already exists (username)` anche se lo username esiste con maiuscole diverse |
| POST | `/auth/login` 🌐 (10/min) | — | `{ identifier?\|email?, password }` | `AuthSession` + set cookie. Account sospeso → errore dedicato |
| POST | `/auth/refresh` 🌐 CSRF | — | nessuno (cookie) | `AuthSession` + cookie ruotato |
| POST | `/auth/logout` 🌐 CSRF | — | nessuno | `Success` + cookie cancellato |
| POST | `/auth/forgot-password` 🌐 (5/min) | — | `{ identifier?\|email?\|username?, redirect_to? }` | `{ success: true, message }` (+ in non-prod: `provider`, `email_sent`, `redirect_to` oppure `reset_token`, `expires_in_seconds`) |
| POST | `/auth/reset-password` 🌐 | — | `{ token, new_password }` | `Success` |
| POST | `/auth/reset-password-supabase` 🌐 | — | `{ access_token, new_password }` | `Success` |
| GET | `/auth/sessions` | tutti | — | `{ id, created_at, expires_at, user_agent: string\|null, ip: string\|null }[]` |
| DELETE | `/auth/sessions/:id` CSRF | tutti | — | `Success` |
| DELETE | `/auth/sessions` CSRF | tutti | — | `Success` (mantiene la sessione corrente) |
| POST | `/auth/change-password` | tutti | `{ current_password, new_password }` | `Success` — **revoca TUTTE le sessioni e cancella il cookie**: il frontend deve fare nuovo login |
| POST | `/auth/push-token` | tutti | `{ push_token }` | `Success` (Expo) |
| POST | `/auth/onboarding/complete` | tutti | — | `{ onboarding_completed: true }` |
| POST | `/auth/push-subscription` | tutti | `{ endpoint, keys: { p256dh, auth }, userAgent? }` | `Success` (Web Push) |
| DELETE | `/auth/push-subscription` | tutti | `{ endpoint }` | `Success` |
| POST | `/auth/push-test` (5/min) | tutti | — | `Success` (invia push di prova a sé stessi) |
| POST | `/auth/activity` | tutti | — | `Success` (heartbeat "online") |
| DELETE | `/auth/me` | tutti | — | `Success` (account anonimizzato, cookie cancellato) |
| GET | `/auth/cleanup-tokens` 🕒 | — | — | `{ success, deleted_refresh_tokens, deleted_reset_tokens }` |

## 4. Users (`/users`)

| Metodo | Path | Ruoli | Body | Ritorna |
|---|---|---|---|---|
| GET | `/users/me` | client, staff, venue, admin | — | `MeUser` |
| PATCH | `/users/me` | idem | `{ name?, phone?, avatar? }` (null per svuotare; `avatar` deve essere un path storage `users/xxx.jpg`, **non** data URL) | `MeUser` |
| POST | `/users/avatar` | idem | multipart `file` | `UploadedPath` |
| POST | `/users/avatar/signed` | idem | `{ ext?, contentType? }` | `SignedUpload` |

⚠️ Il ruolo `organization` **non** può chiamare `/users/me` (non è nei `@Roles`): per l'account organizzazione usare `GET /organizations/me`.

## 5. Events

| Metodo | Path | Ruoli | Query/Body | Ritorna |
|---|---|---|---|---|
| GET | `/events` 🌐 | — | `?venue_id&status=DRAFT\|LIVE\|CLOSED&date=YYYY-MM-DD&page&pageSize` | `EventListItem[]` o paginato. Senza `status` esclude CLOSED. Cache 30s |
| GET | `/events/:id` 🌐 | — | — | `EventDetail`. Cache 60s |
| GET | `/events/:id/friends-going` | client | — | `{ id, username, name, avatar }[]` |
| GET | `/events/:id/stats` | venue, admin | — | `EventStats` |
| GET | `/events/:id/forecast` | staff, venue, admin | — | `AttendanceForecast` (sotto) |
| POST | `/events` | venue, admin, organization | `CreateEventDto` (sotto) | `EventDetail` |
| POST | `/events/poster` | venue, admin, organization | multipart `file` | `UploadedPath` |
| POST | `/events/poster/signed` | venue, admin, organization | `{ ext?, contentType? }` | `SignedUpload` |
| PATCH | `/events/:id` | venue, admin, organization | `UpdateEventDto` | `EventDetail` |
| POST | `/events/:id/cancel` | venue, admin, organization | — | `{ success: true, cancelled_reservations: number }` oppure `{ success: true, already_cancelled: true }` |
| DELETE | `/events/:id` | venue, admin, organization | — | `Success` (400 se ci sono reservation/ticket order) |
| GET | `/events/:eventId/promos` 🌐 | — | — | `Promo[]` (solo attive, discount_value raw) |
| GET | `/events/sync-status` 🕒 | — | — | `{ success, statusUpdated, autoFeaturedUpdated }` |

```ts
type CreateEventDto = {
  venue_id?: string;          // venue: ignorato (forzato al proprio); organization: OBBLIGATORIO e deve essere un venue collegato
  name: string; date: string /* YYYY-MM-DD */; start_time?: string /* HH:MM */; end_time?: string;
  status?: 'DRAFT' | 'LIVE' | 'CLOSED'; access_mode?: 'LIST' | 'PRE_SALE';
  presale_price?: number | string; presale_currency?: string; presale_capacity?: number;
  description?: string; image?: string /* path storage */;
  entry_prices?: { label?: string; gender?: 'M'|'F'|'ALTRO'; start_time?: string; end_time?: string; price: number | string }[];
  table_pricing?: { venue_table_zone_id: string; per_testa?: number|string; costo_minimo?: number|string; persone_max?: number }[];
  promos?: { title: string; description?: string; discount_type: DiscountType; discount_value?: number|string; status?: PromoStatus }[];
  is_featured?: boolean;      // solo admin (ignorato per venue/organization)
};
// UpdateEventDto: stessi campi tutti opzionali; presale_price/presale_capacity accettano null.
// venue/organization non possono spostare venue_id né toccare is_featured.

type AttendanceForecast = {
  event_id: string; people_in_list: number; predicted_from_list: number; expected_walkins: number;
  predicted_value: number; lower_bound: number; upper_bound: number; confidence_score: number;
  show_up_rate: number; personalized_share: number; sample_size: number;
  sample_basis: 'venue_weekday' | 'venue_any_day' | 'global' | 'default'; generated_at: string;
};
```

## 6. Reservations (`/reservations`)

| Metodo | Path | Ruoli | Query/Body | Ritorna |
|---|---|---|---|---|
| GET | `/reservations` | client, venue, staff, admin | `?event_id&user_id&page&pageSize` (accetta anche camelCase). client: solo le proprie. venue/staff: **`event_id` obbligatorio** | `Reservation[]` o paginato |
| GET | `/reservations/booked-tables` 🌐 | — | `?event_id` | `[]` sempre (legacy) |
| GET | `/reservations/booked-zones` 🌐 | — | `?event_id` | `string[]` (id zone con tavolo attivo) |
| POST | `/reservations/guest-join` 🌐 | — | `{ event_id, email? \| username?, guest_name?, guest_surname?, ref_code?... }` | `{ reservation: GuestReservation, already_joined: boolean, guest_token?: string }` |
| GET | `/reservations/guest/:token` 🌐 | — | — | `GuestReservation` |
| GET | `/reservations/table-invitations/incoming` | client | — | `TableInvitation[]` |
| GET | `/reservations/:id` | client (solo propria), venue/staff (del proprio venue), admin | — | `Reservation` |
| POST | `/reservations` | client, venue, admin | vedi sotto | `Reservation` |
| POST | `/reservations/scan-entry-qr` | staff, venue, admin | `{ event_id, qr_data, actual_guests?, staff_id? (solo admin) }` | `ScanResult` |
| PATCH | `/reservations/:id` | venue, admin | `{ status?, guests?, table_name?, total_amount? }` (guests/table/amount solo per `table`) | `Reservation` |
| POST | `/reservations/:id/cancel` | client, venue, admin | — | `Reservation` (status `cancelled`). Client: solo `table` in stato `pending`; entry → 400 "Gli ingressi non sono annullabili dal cliente"; table confermato → 400 "contatta il locale" |
| POST | `/reservations/:id/checkin` | staff, venue, admin | `{ actual_guests? }` | `Reservation` |
| POST | `/reservations/:id/table-invitations/respond` | client | `{ response: 'accepted' \| 'declined' }` | `TableInvitation` |
| GET | `/reservations/sync-status` 🕒 | — | — | `{ success, expired }` |
| GET | `/reservations/send-reminders` 🕒 | — | — | `{ success, reminded }` |

**Body `POST /reservations`** (alias accettati tra parentesi):
```ts
{
  event_id (eventId): string;
  type: 'table' | 'entry';              // entry → auto-confirmed; table → pending
  guests (guests_count, guestsCount, seats, people)?: number;
  venue_zone_id (venueZoneId, venue_table_zone_id, venueTableZoneId)?: string;  // per i tavoli
  table_name (tableName)?: string;
  total_amount?: number;                // IGNORATO per client (calcolato dal server)
  user_id?: string;                     // solo admin; client/venue: forzato al chiamante
  meta?: {
    booking_mode?: string; zone_label?: string;
    invited_friend_ids?: string[]; invited_group_ids?: string[];
    ref_code? | pr_code? | tracking_code? | promo_code?: string; inviter_user_id?: string;
  };
  // ref_code/pr_code/... possono stare anche alla radice: vengono spostati in meta
}
```
Errori tipici 400: "Hai già un tavolo prenotato per questa serata" / "Sei già in lista per questa serata".

```ts
type GuestReservation = { id; event_id; type; status; guests: number; qr_payload: string | null;
  checked_in_at: string | null; created_at: string;
  event: { id; name; date; start_time; end_time; venue: { id; name; city; address } | null } | null };

type TableInvitation = {
  reservation_id: string; invitation_status: 'pending' | 'accepted' | 'declined'; reservation_status: ReservationStatus;
  invited_at: string; responded_at: string | null; guests: number; table_name: string | null;
  zone_label: string | null; total_amount: number | null;
  inviter: { id: string | null; name: string };
  event: { id; name; date; start_time: string | null; end_time: string | null } | null;
  venue: { id; name; city: string | null } | null;
  invited_group_names: string[]; can_respond: boolean;
};

// scan-entry-qr: gestisce sia QR prenotazione sia QR season pass PR
type ScanResult =
  | { success: true; alreadyCheckedIn: true; reservation: Reservation | null; entry?: Entry }
  | { success: true; alreadyCheckedIn: false; reservation: Reservation; entry: Entry; checkedInGuests: number }   // QR prenotazione
  | { success: true; alreadyCheckedIn: false; reservation: null; entry: Entry };                                   // QR season pass PR
type Entry = { id; event_id; user_id; staff_id; station_id; pr_membership_id; sesso: Gender; price: string;
  is_complimentary: boolean; age_bucket: AgeBucket | null; method: 'QR' | 'RAPIDO'; created_at };
```

## 7. Friends & gruppi

| Metodo | Path | Ruoli | Body/Query | Ritorna |
|---|---|---|---|---|
| GET | `/friends/search?query=` (20/min) | client | — | `{ id, username, name, avatar, is_verified_pr, mutual_friends_count, mutual_friends_ids: string[], mutual_friends: {id,username,name,avatar}[] }[]` |
| GET | `/friends` | client | — | `Friend[]` (sotto) ordinati online-first |
| GET | `/friends/map` | client | — | `FriendsMap` (sotto) |
| GET | `/friends/tonight` | client | — | `{ id, username, name, avatar, event_id, event_name, event_date, venue_id, venue_name }[]` (prossimo evento di ogni amico) |
| POST | `/friends/location` | client | `{ latitude, longitude, accuracy?, timestamp? }` | `{ user_id, sharing_enabled, location_updated_at: string \| null }` |
| POST | `/friends/location-sharing` | client | `{ enabled: boolean }` | `{ user_id, sharing_enabled, last_location_updated_at }` |
| GET | `/friends/requests` | client | — | `{ incoming: (FriendRequest & { from_user: MiniUser })[], outgoing: (FriendRequest & { to_user: MiniUser })[] }` |
| POST | `/friends/requests` | client | `{ username? \| user_id? }` | riga `friend_requests` creata, oppure `{ alreadyRequested: true }` / `{ alreadyFriends: true }` |
| POST | `/friends/requests/:id/accept` | client | — | `Success` |
| POST | `/friends/requests/:id/reject` | client | — | `Success` |
| DELETE | `/friends/requests/:id` | client | — | `Success` (annulla la **propria** richiesta pending — esiste) |
| DELETE | `/friends/:id` | client | — | `Success` (rimuove l'amicizia) |
| GET | `/friend-groups` | client | — | `Group[]` |
| POST | `/friend-groups` | client | `{ name, member_ids?: string[] }` | `Group` (400 con `invalid_member_ids` se id non validi) |
| POST | `/friend-groups/:id` | client (owner) | `{ name? }` | riga `friend_groups` aggiornata (**POST**, non PATCH) |
| DELETE | `/friend-groups/:id` | client (owner) | — | `Success` |
| POST | `/friend-groups/:id/members` | client (owner) | `{ user_id }` | riga `friend_group_members` |
| DELETE | `/friend-groups/:id/members/:userId` | client (owner) | — | `Success` |
| GET | `/friend-groups/:id/table-proposals` | client (membro) | — | `Proposal[]` |
| POST | `/friend-groups/:id/table-proposals` | client | `{ venue_id, event_id?, guests, note? }` | `Proposal` |
| POST | `/friend-groups/:id/table-proposals/:proposalId/vote` | client | `{ vote: 'yes' \| 'no' }` | `Proposal` |
| POST | `/friend-groups/:id/table-proposals/:proposalId/book` | client (creatore/owner) | `{ table_name? }` | `{ reservation: Reservation, proposal_id, booked_guests }` o `{ reservation, proposal_id, already_booked: true }` |
| POST | `/friend-groups/:id/table-proposals/:proposalId/cancel` | client (creatore/owner) | — | `Proposal` |

```ts
type MiniUser = { id: string; username: string | null; name: string | null; avatar: string | null };
type FriendRequest = { id; from_user_id; to_user_id; status: FriendRequestStatus; created_at; updated_at };
type Friend = MiniUser & {
  online: boolean; current_venue: string | null; presence_type: string | null;
  status: 'Nel locale' | 'Vicino al locale' | 'Attivo ora' | null;
  last_active_at: string | null; last_seen_at: string | null; last_seen_minutes_ago: number | null;
  sharing_enabled: boolean; is_stale: boolean; is_verified_pr: boolean;
};
type FriendsMap = {
  sharing_enabled: boolean; my_last_location_updated_at: string | null;
  friends: (MiniUser & { sharing_enabled: boolean; last_seen_at: string | null; last_seen_minutes_ago: number | null;
            is_stale: boolean; position: { latitude: number; longitude: number; accuracy_meters: number | null } | null })[];
  hotspots: { venue_id; venue_name; latitude: number; longitude: number; radius_meters: number; friend_count: number;
              active_event_count: number; upcoming_event_count: number; vibe: 'hot' | 'warm';
              friends: { id; name; avatar }[] }[];
};
type Group = { id; owner_id; name; created_at; updated_at; members: { id; group_id; user_id; created_at; user: MiniUser }[] };
type Proposal = {
  id; group_id; status: GroupProposalStatus; guests: number; note: string | null; created_at; updated_at;
  created_by_user: MiniUser;
  event: { id; name; date; start_time; end_time; status };
  venue: { id; name; city; image };
  booked_reservation: { id; status; guests; created_at } | null;
  votes: { id; proposal_id; user_id; vote: GroupProposalVote; created_at; updated_at; user: MiniUser }[];
  vote_stats: { yes: number; no: number; pending: number };
};
```

## 8. Venues (`/venues`)

### 8.1 Anagrafica, immagini, pricing

| Metodo | Path | Ruoli | Body | Ritorna |
|---|---|---|---|---|
| GET | `/venues` 🌐 | — | — | `{ id, name, city, address, description, image, latitude, longitude (Decimal raw), radius_geofence, created_at, updated_at }[]` |
| GET | `/venues/:id` 🌐 | — | — | riga `venues` **completa** raw (inclusi campi contract/stripe, Decimal come stringa) |
| POST | `/venues` | admin | `{ name, city?, address?, radius_geofence?, stripe_account_id? }` | riga `venues` |
| PATCH | `/venues/:id` | admin | idem, tutti opzionali | riga `venues` |
| DELETE | `/venues/:id` | admin | — | riga `venues` eliminata |
| PATCH | `/venues/:id/image` | venue (proprio), admin | `{ image: string \| null }` (path storage `venues/...`) | riga `venues` |
| POST | `/venues/:id/image` | venue, admin | multipart `file` | `UploadedPath` |
| POST | `/venues/:id/image/signed` | venue, admin | `{ ext?, contentType? }` | `SignedUpload` |
| GET | `/venues/:id/pricing` | staff, venue (proprio), admin | — | `VenuePricing` |
| PATCH | `/venues/:id/pricing` | venue, admin | `{ cloakroom_unit_price?, bar_price_list?: {key,label?,price}[], bottle_price_list?: {key,label?,price}[] }` | `VenuePricing` |
| GET | `/venues/:id/events` 🌐 | — | `?status&date` | `EventListItem[]` |
| GET | `/venues/:id/promos` 🌐 | — | — | `Promo[]` (**tutte** le promo del venue, qualsiasi status) ⚠️ vedi nota §13 |

```ts
type VenuePricing = { venue_id: string; cloakroom_unit_price: number;
  bar_price_list: { key: string; label: string; price: number }[];
  bottle_price_list: { key: string; label: string; price: number }[] };
```

### 8.2 Wallet template (tessera PR brandizzata)

| Metodo | Path | Ruoli | Body | Ritorna |
|---|---|---|---|---|
| GET | `/venues/:id/wallet-template` | venue (proprio), admin | — | `WalletTemplate \| null` |
| PATCH | `/venues/:id/wallet-template` | idem | `{ background_color?, foreground_color?, label_color? }` formato `"rgb(r, g, b)"` o null | `WalletTemplate` |
| POST | `/venues/:id/wallet-template/logo` | idem | multipart `file` | `WalletTemplate` |
| DELETE | `/venues/:id/wallet-template/logo` | idem | — | `WalletTemplate` (logo_path null) |

`WalletTemplate = { id, venue_id, logo_path: string|null, background_color, foreground_color, label_color, created_at, updated_at }`

### 8.3 Zone tavoli, tavoli, planimetria, postazioni

| Metodo | Path | Ruoli | Body | Ritorna |
|---|---|---|---|---|
| GET | `/venues/:id/table-zones` 🌐 | — | — | riga `venue_table_zones[]` (anche inattive; Decimal raw) |
| POST | `/venues/:id/table-zones` | venue, admin | `{ name, color?, per_testa?, costo_minimo?, persone_max?, booking_policy?, sort_order?, floor_x/y/w/h?, is_active? }` | riga zona |
| PATCH | `/venues/:id/table-zones/:zoneId` | venue, admin | idem opzionali (nullable per prezzi/floor) | riga zona |
| DELETE | `/venues/:id/table-zones/:zoneId` | venue, admin | — | riga zona eliminata |
| POST | `/venues/:id/table-zones/:zoneId/tables` | venue, admin | `{ count, name_prefix?, start_number?, columns?, floor_w?, floor_h?, base_x?, base_y?, gap_x?, gap_y? }` | `venue_tables[]` (tutti i tavoli del venue) |
| GET | `/venues/:id/tables` 🌐 | — | — | `venue_tables[]` |
| POST | `/venues/:id/tables` | venue, admin | `{ tables: { nome, venue_table_zone_id?, zona?, numero?, per_testa?, costo_minimo?, persone_max?, floor_x/y/w/h?, floor_shape?, floor_rotation?, layout_order?, is_hidden? }[] }` | `venue_tables[]` (tutti) |
| PATCH | `/venues/:id/tables/:tableId` | venue, admin | campi tavolo opzionali | riga `venue_tables` |
| DELETE | `/venues/:id/tables/:tableId` | venue, admin | — | riga eliminata |
| GET | `/venues/:id/floor-plan` 🌐 | — | — | `{ ...venue_floor_plans (Decimal raw), landmarks: venue_floor_landmarks[], zones: venue_table_zones[] (solo attive), tables: venue_tables[] }` |
| PATCH | `/venues/:id/floor-plan` | venue, admin | `{ background_image?, canvas_width?, canvas_height?, grid_size?, show_grid? }` | come GET |
| POST | `/venues/:id/floor-plan/landmarks` | venue, admin | `{ type?: 'dj_console', label?, x?, y?, width?, height?, rotation?, color?, sort_order?, metadata? }` | riga landmark |
| PATCH | `/venues/:id/floor-plan/landmarks/:landmarkId` | venue, admin | idem | riga landmark |
| DELETE | `/venues/:id/floor-plan/landmarks/:landmarkId` | venue, admin | — | riga eliminata |
| GET | `/venues/:id/stations` | staff, venue (proprio), admin | — | `venue_stations[]` = `{ id, venue_id, name, station_type, is_active, sort_order, created_at, updated_at }` |
| POST | `/venues/:id/stations` | venue, admin | `{ stations: { name, station_type, is_active?, sort_order? }[] }` | `venue_stations[]` (tutte) |
| PATCH | `/venues/:id/stations/:stationId` | venue, admin | `{ name?, station_type?, is_active?, sort_order? }` | riga station |
| DELETE | `/venues/:id/stations/:stationId` | venue, admin | — | riga eliminata |

### 8.4 Statistiche & analytics (venue proprio o admin)

| Metodo | Path | Query | Ritorna |
|---|---|---|---|
| GET | `/venues/:id/stats` | — | `{ eventsCount, promosCount, reservationsCount, totalReservationAmount: number }` |
| GET | `/venues/:id/analytics` | — | `VenueAnalytics` (sotto) |
| GET | `/venues/:id/analytics/overview` | `?eventId` | `{ venue_id, event_id, generated_at, overview: { eventsCount, reservationsCount, entriesCount, ticketOrdersCount, avgStayMinutes, totalRevenue, entryRevenue, barRevenue, cloakroomRevenue, tableRevenue } }` |
| GET | `/venues/:id/analytics/demographics` | `?eventId` | senza eventId: `{ venue_id, generated_at, audience, avgStayMinutes }`; con eventId: `{ venue_id, event_id, generated_at, audience: { averageAge, genderSplit: {label,count}[], ageBuckets }, note }` |
| GET | `/venues/:id/analytics/revenue-breakdown` | `?eventId` | `{ venue_id, event_id, generated_at, totals: { reservationEntryRevenue, directEntryRevenue, entryRevenue, barRevenue, cloakroomRevenue, tableRevenue, totalRevenue }, stations: { channel, station_id, station_name, station_type, total_amount, transaction_count, last_activity_at }[], stationTypeCatalog: { key, label }[] }` |

```ts
type Dist = { label: string; count: number; share?: number };
type VenueAnalytics = {
  venue_id; venue_name; generated_at;
  overview: { totalRevenue; totalEntries; totalReservations; totalTableGuests; totalPresences;
              avgRevenuePerEvent; avgRevenuePerPresence; avgStayMinutes };
  audience: { uniqueCustomers; repeatCustomers; repeatRate; averageAge: number | null; genderSplit: Dist[]; ageBuckets: Dist[];
              ageEntryWindows: { label; count; avgEntryHour; peakEntryHour }[] };
  bookings: { avgLeadDays; bestEventWeekday; bestBookingWeekday; bestBookingHour; busiestEntryHour;
              byEventWeekday: Dist[]; byBookingWeekday: Dist[]; byBookingHour: Dist[]; leadTimeBuckets: Dist[] };
  revenue: { channelMix: { label: 'Ingressi'|'Bar'|'Guardaroba'|'Tavoli'; value; share }[];
             averagePerClosedEvent: { revenue; entriesRevenue; barRevenue; cloakroomRevenue; tablesRevenue; entries; presences };
             weekdayBenchmarks: any[] };
  historical: { totalEvents; closedEvents; topEvent: EventSummary | null };
  events: EventSummary[];
};
type EventSummary = { event_id; name; date; status; totalRevenue; entriesRevenue; barRevenue; cloakroomRevenue;
  tablesRevenue; totalEntries; totalReservations; totalTableGuests; totalPresences; avgSpendPerPresence;
  averageAge: number | null; topEntryHour: string | null; women; men; other; unknown };
```

### 8.5 Organizzazioni viste dal venue

| Metodo | Path | Ruoli | Ritorna |
|---|---|---|---|
| GET | `/venues/:id/organizations` | venue (proprio), admin | `{ id, organization_id, venue_id, created_by_admin_id, created_at, organization: { id, name, is_active } }[]` |
| GET | `/venues/:id/organizations/:orgId/stats` | idem | `{ active_pr_count, total_pr_count, total_scans, total_attributed_entries }` |

### 8.6 Rete PR (lato venue)

Tutti con `@Roles('client','staff','venue','admin')`: l'autorizzazione reale (owner del venue / responsabile PR / PR) è nel service → aspettarsi 403 se non si ha il permesso.

| Metodo | Path | Body/Query | Ritorna |
|---|---|---|---|
| GET | `/venues/pr-network/me` | — | `{ membership_id, venue_id, venue_name, venue_city, role: PrRoleApi, parent_membership_id, ref_code, is_active, can_manage_team, created_at, updated_at }[]` (tutte le mie membership) |
| GET | `/venues/:id/pr-network/me` | — | `{ venue_id, can_access_dashboard: boolean, can_manage_team: boolean, membership: { id, user_id, role, parent_membership_id, ref_code, is_active, created_at, updated_at } \| null }` |
| GET | `/venues/:id/pr-network/me/season-pass` | — | `SeasonPassResponse` (403 se nessuna membership attiva) |
| POST | `/venues/:id/pr-network/me/season-pass/refresh-wallet` | — | `SeasonPassResponse` (link wallet rigenerati) |
| GET | `/venues/:id/users?search=` | — | `{ id, name, username, email, role, venue_id, is_associated_to_venue, already_assigned, display_name }[]` |
| GET | `/venues/:id/pr-network/lookup?identifier=` | ruoli: venue (proprio), admin, organization (venue collegato) | `{ id, name, email, username, role }` (id/email/username) |
| GET | `/venues/:id/pr-network` | — | `PrMember[]` (esclusi i PR esclusivi di organizzazioni) |
| POST | `/venues/:id/pr-network` | `{ user_id, role: 'responsabile'\|'pr', parent_membership_id?, ref_code? }` (`organization_id` **non più accettato** lato venue) | `PrMember` |
| PATCH | `/venues/:id/pr-network/:memberId` | `{ role?, parent_membership_id?, is_active?, ref_code? }` | `PrMember` |
| DELETE | `/venues/:id/pr-network/:memberId` | — | `{ deleted: true, id }` |
| POST | `/venues/:id/pr-events/assignments` | `{ event_id, pr_membership_id, is_active? }` | `PrEventAssignment` |
| GET | `/venues/:id/pr-events/:eventId/assignments` | — | `PrEventAssignment[]` |
| POST | `/venues/:id/pr-scans` | `{ event_id, pr_membership_id? \| ref_code?, guest_user_id?, metadata? }` | `PrScan` |
| POST | `/venues/:id/pr-scans/:scanId/entry` | `{ guest_user_id?, station_id?, entry_type?: 'male'\|'female'\|'free', gender?, is_complimentary?, age_bucket? }` | `{ already_registered: boolean, scan: PrScan, entry: { id, event_id, user_id, staff_id, station_id, pr_membership_id, method, sesso, price: number, created_at } \| null }` |
| GET | `/venues/:id/pr-dashboard?eventId&membershipId` | — | `PrDashboard` |
| GET | `/venues/passes/apple/:passId?token=` 🌐 | — | **file binario** `.pkpass` (`application/vnd.apple.pkpass`) |

```ts
type SeasonPassResponse = { venue_id; venue_name; membership_id; generated_at;
  pass: { id; venue_id; pr_membership_id; user_id; role: PrRoleApi; status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
          membership_is_active: boolean; valid_from; valid_until; revoked_at: string | null; serial_number;
          wallet_apple_url: string | null; wallet_google_url: string | null; wallet_last_issued_at: string | null;
          qr_data: string /* JSON string da mettere nel QR */; created_at; updated_at } };
type PrEventAssignment = { id; venue_id; event_id; pr_membership_id; is_active; assigned_by_user_id; created_at; updated_at;
  membership: { id; role: PrRoleApi; ref_code; parent_membership_id; display_name; user: { name; username; email } } };
type PrScan = { id; venue_id; event_id; pr_membership_id; scanned_by_user_id; guest_user_id; referral_code;
  scanned_at; entry_id: string | null; entered_at: string | null; metadata: any; created_at; updated_at };
type PrStats = { scans: number; entries: number; referral_reservations: number };
type PrDashboard = { venue_id; event_id: string | null; scope: 'OWNER' | PrRoleApi; can_manage_team: boolean;
  totals: PrStats; generated_at: string;
  members: { id; user_id; role: PrRoleApi; parent_membership_id; ref_code; is_active; created_at; updated_at;
             display_name; user: { id; name; username; email }; stats: PrStats; team_stats: PrStats }[] };
```

## 9. Organizations (`/organizations`)

| Metodo | Path | Ruoli | Body/Query | Ritorna |
|---|---|---|---|---|
| POST | `/organizations` | admin | `{ name, vat_number? }` | riga `organizations` |
| GET | `/organizations` | admin | — | `(Organization & { _count: { venue_links, pr_memberships }, plan: PlanMini \| null, owners: OwnerMini[] })[]` |
| GET | `/organizations/me` | tutti (serve `organization_id` sul token) | — | `OrganizationDetail` (404 se l'account non ha org) |
| GET | `/organizations/:id` | admin, organization (propria) | — | `OrganizationDetail` |
| PATCH | `/organizations/:id` | admin | `{ name?, vat_number?, is_active? }` | riga `organizations` |
| PATCH | `/organizations/:id/plan` | admin | `{ plan_id: string \| null }` | `Organization & { plan: PlanMini \| null }` |
| POST | `/organizations/:id/venue-links` | admin | `{ venue_id }` | `{ id, organization_id, venue_id, created_by_admin_id, created_at, venue: { id, name, city } }` |
| DELETE | `/organizations/:id/venue-links/:venueId` | admin | — | `Success` |
| GET | `/organizations/:id/venues` | admin, organization | — | `{ id, organization_id, venue_id, created_by_admin_id, created_at, venue: { id, name, city, image } }[]` |
| GET | `/organizations/:id/pr-network` | admin, organization | — | `{ id, role: 'responsabile'\|'pr' (⚠️ minuscolo, raw), parent_membership_id, is_active, ref_code, venues: {id,name,city}[], user: {id,name,username,email}, display_name, created_at }[]` |
| GET | `/organizations/:id/pr-network/lookup?identifier=` | admin, organization | — | `{ id, name, email, username, role }` |
| POST | `/organizations/:id/pr-network` | admin, organization | `{ user_id, role, parent_membership_id?, ref_code? }` | `PrMember` (venue_id null: vale su tutti i venue collegati) |
| PATCH | `/organizations/:id/pr-network/:memberId` | admin, organization | `{ role?, parent_membership_id?, is_active?, ref_code? }` | `PrMember` |
| DELETE | `/organizations/:id/pr-network/:memberId` | admin, organization | — | `{ deleted: true, id }` |
| GET | `/organizations/:id/events` | admin, organization | — | riga `events[]` **raw** (date ISO, Decimal stringa) + `venue: { id, name, city }`, `entry_prices: event_entry_prices[]` |
| GET | `/organizations/:id/stats?venue_id=` | admin, organization | — | `{ active_pr_count, total_pr_count, total_scans, total_attributed_entries, by_venue: { venue: {id,name,city}, active_pr_count, total_scans, total_attributed_entries }[] }` |
| GET | `/organizations/:id/usage` | admin, organization | — | `OrgUsage` |

```ts
type Organization = { id; name; vat_number: string | null; is_active: boolean; plan_id: string | null; created_at; updated_at };
type PlanMini = { id; key; name; icon: string | null };
type OwnerMini = { id; name; username; email };
type OrganizationDetail = Organization & { plan: PlanMini | null; owners: OwnerMini[];
  venue_links: { id; organization_id; venue_id; created_by_admin_id; created_at; venue: { id; name; city } }[] };
type OrgUsage = { plan: PlanMini | null; period: { start: string; end: string };
  events_count: number; people_count: number; included_events: number | null; included_people: number | null;
  extra_events_count: number; extra_people_count: number; extra_events_cost: number; extra_people_cost: number; overage_cost: number };
```

## 10. Staff (`/staff`) — ruoli staff, venue, admin

Nei GET, se `eventId` non è passato il server usa l'evento LIVE attivo del venue del chiamante. `venueId`/`staffId` in query sono considerati solo per admin.

| Metodo | Path | Body/Query | Ritorna |
|---|---|---|---|
| POST | `/staff/entries` | `{ event_id?, station_id?, user_id?, quantity? (default 1; =1 se user_id), entry_type?: 'male'\|'female'\|'free', gender?, is_complimentary?, age_bucket? }` | `{ success: true, created: number, stats: EventStats }` |
| GET | `/staff/entries` | `?eventId` | righe `entries[]` raw (max N) |
| POST | `/staff/bar-sales` | `{ event_id?, station_id?, amount }` | `{ sale: bar_sales, stats: EventStats }` |
| GET | `/staff/bar-sales` | `?eventId` | `bar_sales[]` raw |
| POST | `/staff/cloakroom-sales` | idem | `{ sale, stats }` |
| GET | `/staff/cloakroom-sales` | `?eventId` | `cloakroom_sales[]` raw |
| POST | `/staff/table-sales` | `{ event_id?, event_table_id, station_id?, amount }` | `{ sale, stats }` |
| GET | `/staff/table-sales` | `?eventId` | `table_sales[]` raw |
| GET | `/staff/events/:eventId/stats` | — | `EventStats` |
| GET | `/staff/hostess-tables` | `?eventId&onlyBooked&includeConfirmed` | `HostessTable[]` |
| POST | `/staff/hostess-tables/:id/update-entrati` | `{ delta }` | riga `event_tables` |
| POST | `/staff/hostess-tables/:id/assign-number` | `{ numero }` | riga `event_tables` + `venue_table_zone` |
| PATCH | `/staff/hostess-tables/:id` | `{ action: 'update_entrati'\|'assign_number'\|'set_confirmed', delta?, numero?, confirmed? }` | riga `event_tables` |
| PATCH | `/staff/hostess/tables/:id` | `{ entrati?, pagato_iniziale? }` | riga `event_tables` |
| GET | `/staff/waiter/tables` | `?eventId&onlyBooked` | `WaiterTable[]` |
| POST | `/staff/waiter/tables/:id/payment` | `{ amount, station_id? }` | `{ table: event_tables, sale: table_sales }` |
| POST | `/staff/waiter/tables/:id/bottle-orders` | `{ bottle_name, quantity, unit_price, bottle_key?, note?, auto_settle?, station_id? }` | `BottleOrder` |
| POST | `/staff/waiter/tables/:id/settle` | — | riga `event_tables` (stato `saldato`) |
| GET | `/staff/bottle-orders` | `?eventId&status` | `BottleOrder[]` |
| POST | `/staff/bottle-orders/:id/prepare` | — | `BottleOrder` |
| POST | `/staff/bottle-orders/:id/dispatch` | — | `BottleOrder` (delivered) |

```ts
type HostessTable = { id; event_id; venue_table_zone_id; table_name: string | null; prenotati: number; entrati: number;
  pagato_totale: string; spesa_minima: number; totale_incassato: number; per_testa; costo_minimo; confermato: boolean;
  stato: string; numero: number | null; venue_table_zone: any; event: any };
type WaiterTable = { id; event_id; venue_id; nome; table_name; zona; per_testa; costo_minimo; prenotati; entrati;
  numero: number | null; pagato_iniziale: null; pagato_totale: string; spesa_minima: number; totale_incassato: number;
  stato_pagamento: 'saldato' | 'parziale' | 'in_attesa'; is_saldato: boolean; table_waiters: [];
  table_sales: { id; amount: number; created_at }[]; bottle_orders: BottleOrderLite[] };
type BottleOrder = { id; event_table_id; bottle_name; quantity: number; unit_price: number; total_price: number;
  status: BottleOrderStatus; note: string | null; created_at; prepared_at: string | null; delivered_at: string | null;
  requested_by_staff_id; prepared_by_staff_id; delivered_by_staff_id; is_table_saldato: boolean;
  table: { id; event_id; numero; nome; zona; table_name; prenotati: number; entrati: number } | null };
```

## 11. Promos

| Metodo | Path | Ruoli | Ritorna |
|---|---|---|---|
| GET | `/public/promos/active` 🌐 | — | `Promo[]` attive (tutte) |
| GET | `/promos/active` | client, venue, admin | client: promo attive filtrate per segmento utente; venue: attive del proprio venue; admin: tutte attive → `Promo[]` |
| GET | `/promos` | venue, admin | `Promo[]` (venue: le proprie) — `page/pageSize` ignorati |
| GET | `/promos/:id` (UUID v4) | venue, admin | `Promo` |
| GET | `/promos/by-event/:eventId` | venue, admin | `Promo[]` |
| GET | `/promos/by-venue/:venueId` | venue, admin | `Promo[]` |
| POST | `/promos` | venue, admin | body: `{ title, description?, discount_type, discount_value?, status?, event_id? }` (venue_id forzato per venue) → `Promo` (+ push ai clienti) |
| PATCH | `/promos/:id` | venue, admin | campi promo → `Promo` |
| DELETE | `/promos/:id` | venue, admin | `Promo` eliminata |

Segmentazione: una riga nella `description` del tipo `segment=specific|new|loyal|churn; weeks=N; customers=@a,@b` controlla a chi è visibile la promo in `/promos/active` (client).

## 12. Badges, venue-stays, moderazione, admin

### Badges (`/badges`, ruolo client salvo dove indicato)

| Metodo | Path | Ritorna |
|---|---|---|
| GET | `/badges/catalog` | `PublicBadge[]` (tutti `isUnlocked: false`) |
| GET | `/badges/user/:userId` (`me` accettato) | `PublicBadge[]` — per sé con `progress`; per un amico solo badge pubblici, `progress: null`; non amico → 403 |
| GET | `/badges/me` | `user_badges[]` con `badge` incluso (riga completa); esclusi i badge disattivati |
| GET | `/badges/level` | `{ eventsCount, current: Level, next: Level \| null, eventsToNextLevel }` con `Level = { level, code, name, icon, minEvents }` |
| GET | `/badges/level/:userId` (`me` accettato) | stessa forma di `/badges/level`, per sé o per un amico; non amico → 403 |
| POST | `/badges/sync` | riga `badges[]` appena sbloccati (può essere `[]`) |
| POST | `/badges/:userBadgeId/seen` | `{ count: number }` |
| POST | `/badges/admin/award` (admin) | body `{ user_id, badge_code }` → riga `user_badges` |

`PublicBadge = { id, code, category, rarity, icon, name, description, isSecret, isPublic, isUnlocked, unlockedAt: string|null, progress: { current, target } | null }` (⚠️ camelCase qui). Badge segreti non sbloccati: stessi campi. `isPublic: false` = visibile solo al proprietario (es. `big_spender`). I badge che contavano solo le serate (`prima_notte`, `night_lover`, …) sono disattivati: duplicavano il livello notte.

### Venue stays (`/venue-stays`)

| Metodo | Path | Ruoli | Body/Query | Ritorna |
|---|---|---|---|---|
| POST | `/venue-stays/checkpoint` | client | `{ venue_id, event_id?, event_type: 'enter'\|'exit', timestamp? }` | riga `venue_stays` (`{ id, user_id, venue_id, event_id, entered_at, exited_at, duration_ms, created_at, updated_at }`). `exit` senza stay aperta → 404 |
| GET | `/venue-stays` | client (proprie), venue (del proprio venue), admin | `?user_id&venue_id&event_id&limit` (max 500) | `venue_stays[]` |

### Moderazione

| Metodo | Path | Ruoli | Body/Query | Ritorna |
|---|---|---|---|---|
| POST | `/reports` | tutti | `{ reported_user_id, reason }` | riga `content_reports` |
| GET | `/admin/content-reports?status=` | admin | — | `(content_reports & { reporter: {id,name,email}, reported_user: {id,name,email,is_active} })[]` (max 100) |
| PATCH | `/admin/content-reports/:id` | admin | `{ status: 'resolved'\|'dismissed', resolution_note?, suspend_reported_user? }` | riga `content_reports` |

### Admin (`/admin`, solo admin)

| Metodo | Path | Body/Query | Ritorna |
|---|---|---|---|
| GET | `/admin/dashboard` | — | `{ metrics: { totalVenues, activeVenues, totalUsers, totalTicketsSold, totalReservations, activeUsers30d, eventsCompletedMonth, eventsActiveToday, contractsExpiringIn30d, contractsMissingData, revenueMonth, platformRevenueMonth, reservationsToday, newUsers30d, avgOrderValue, sessions30d, avgStayMinutes30d }, revenue: serie settimanale, alerts, topVenues: {id,name,revenue}[], ordersMonth: { total, paid }, expiringContracts }` |
| GET | `/admin/venues` | — | `{ id, name, city, address, status: 'Operativo', occupancy, activeGuests, revenue, eventsActive, contractExpiresAt, contractDaysLeft, contractEstimated, contractStartAt, contractStatus, contractMonthlyFee, contractAutoRenew, contractNotes, billedThisMonth, managerUserId, managerName, managerEmail }[]` |
| POST | `/admin/venues` | `{ name, city?, address?, radius_geofence?, contract_start_at?, contract_end_at?, contract_status?, contract_monthly_fee?, contract_auto_renew?, contract_notes?, manager_user_id? }` | riga `venues` (lat/lng/fee come number) |
| PATCH | `/admin/venues/:id/contract` | campi `contract_*` (nullable) | riga `venues` (fee number) |
| GET | `/admin/users` | — | `{ id, name, email, roleKey, venueId, venueName, role (label), status: 'Attivo'\|'Inattivo', joinedAt, lastActivityAt, sessions30d, avgStayMinutes30d }[]` (50 più recenti) |
| GET | `/admin/users/search?search=` | — | `{ id, name, email, username, role, is_active, venue_id, created_at }[]` |
| POST | `/admin/users/:id/suspend` · `/reactivate` | (`:id` = id/email/username) | `{ id, name, email, username, role, is_active }` |
| PATCH | `/admin/users/:id/assignment` | `{ role, venue_id?, organization_id? }` | `{ id, name, email, role, venueId, venueName, organizationId, organizationName }` |
| GET | `/admin/accounts?search=` | — | `{ id, name, type: 'venue', location, active, revenue_label, member_since }[]` |
| POST | `/admin/accounts/:id/suspend` · `/reactivate` | — | stesso oggetto account |
| GET | `/admin/audit-log?target_type&target_id` | — | `admin_audit_logs[]` (max 200) |
| GET | `/admin/plans` | — | `Plan[]` |
| POST | `/admin/plans` | `{ key, name, tagline?, icon?, monthly_price?, included_events?, included_people?, extra_event_price?, extra_person_price?, is_custom?, is_recommended?, is_active?, sort_order? }` | `Plan` |
| PATCH | `/admin/plans/:id` | idem opzionali (nullable) | `Plan` |
| DELETE | `/admin/plans/:id` | — | `Success` |
| GET | `/admin/reports` | — | `{ revenue, monthTotal, monthHint, monthVsPrevious, channelBreakdown: { entries, tables }, paidOrders }` |
| GET | `/admin/profile` | — | `{ name, email, role }` |
| GET | `/admin/me` | — | `{ id, name, email, username, phone, avatar, role: 'admin', createdAt, lastActiveAt, team: {id,name,email,createdAt}[], alerts }` |

`Plan = { id, key, name, tagline, icon, monthlyPrice, includedEvents, includedPeople, extraEventPrice, extraPersonPrice, isCustom, isRecommended, isActive, sortOrder }` (⚠️ camelCase, a differenza di `PATCH /organizations/:id/plan` che usa snake_case).

⚠️ Rimossi il 2026-08-20 (non chiamarli più): `PATCH /admin/venues/:id/plan`, qualunque campo `plan_id`/`plan_custom_terms` sui venue.

---

## 13. Incongruenze da conoscere lato frontend

1. **Naming misto**: la maggior parte delle risposte è snake_case, ma `/admin/*`, `/badges/*` (PublicBadge, level) e analytics venue (`/venues/:id/analytics*`) sono **camelCase**.
2. **Ruolo PR**: `RESPONSABILE`/`PR` maiuscolo negli endpoint `/venues/...pr-*`, ma `responsabile`/`pr` minuscolo in `GET /organizations/:id/pr-network`.
3. **`/users/me` vs sessione auth**: forme diverse (vedi `MeUser` vs `PublicUser`); `organization_id` è solo in quella di `/auth/*`.
4. **Decimal come stringa** negli endpoint raw (tabella §0) — gli endpoint eventi, pricing, analytics, staff "tavoli" convertono invece in number.
5. `GET /venues/:venueId/promos` è dichiarato due volte (VenuesController → **tutte** le promo, PublicPromosController → solo **attive**). `VenuesModule` è registrato prima di `PromosModule` in `app.module.ts`, quindi oggi risponde VenuesController: arrivano anche promo `inactive`/`expired`. Filtrare `status === 'active'` lato client.
6. `GET /venues/:id` pubblico restituisce l'intera riga venue (inclusi campi contratto e Stripe): il frontend non deve mostrarli, e conviene segnalarlo come da restringere lato backend.
7. `POST /friend-groups/:id` è l'update del nome (POST, non PATCH).
8. Il ruolo `organization` non può usare `/users/me` né la maggior parte di `/venues/:id/*` (solo `pr-network/lookup`).
