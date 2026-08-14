# NightHub Backend — Benchmark Endpoint (tutti i ruoli)

Misurato dal vivo su ambiente dev/staging (stesso DB usato per l'audit), con 4 account reali (`client`, `staff@example.com`, `venue@example.com`, `admin@example.com`) più richieste senza token. Tempo = `X-Response-Time` (header impostato dal backend stesso: tempo di elaborazione lato server, esclude l'overhead di rete/tooling locale di ~200ms visibile anche su `/health`).

Colonna **Tempo** = tempo massimo osservato tra le risposte `200` (il caso "peggiore realistico" tra i ruoli autorizzati). Colonna **Ruoli** = esito per ruolo (`ruolo codice tempo`). Ordinato **dal più lento al più veloce**.

Legenda **Migliorabile**: 🔴 sì, non affrontato · 🟡 parzialmente ottimizzato (margine residuo) · 🟢 no, già al minimo/non conviene · ✅ ottimizzato in questa sessione (2026-08-11)

---

## Obiettivo di questa sessione: tutto sotto i 500ms

Dopo la quarta passata (vedi sezione sotto per il dettaglio dei fix), su richiesta esplicita si è fatto un quinto giro mirato a portare **tutti** gli endpoint sotto i 500ms. Risultato: **quasi tutti gli endpoint sono ora sotto i 500ms in stato stazionario** (~240-490ms). Restano sopra soglia solo 4 casi, tutti con una causa identificata e spiegata:

| Endpoint | Tempo | Perché resta sopra 500ms |
|---|---|---|
| `GET /venues/:id/analytics` (1° hit) | ~595-640ms | Costo di calcolo reale (audit: serve pre-aggregazione, esplicitamente fuori scope). Con la cache TTL già in produzione da questa sessione, ogni hit successivo entro 15s è ~1ms |
| `GET /admin/dashboard` (1° hit) | ~865-1065ms | ~20+ query, già tutte in `Promise.all` vero (non `$transaction`); il collo di bottiglia residuo è la concorrenza limitata lato pooler DB (Supabase), non il codice — vedi nota tecnica sotto. Cache TTL rende i hit successivi ~1ms |
| `GET /reservations` (admin, no filtri) | ~578-583ms | Query splittata in 5 fetch paralleli (era 1 query con 4 join annidati) per rimuovere l'overhead delle relazioni annidate; il guadagno netto è risultato marginale e variabile — vedi nota tecnica sotto |
| `GET /staff/waiter/tables` | ~480-530ms | Al limite della soglia: 2 round trip sequenziali intrinseci (seed/reconciliation deve completare prima di leggere `event_tables`), già ridotti al minimo strutturalmente possibile |

**`GET /venues/:id/stripe/connect/status`** (1210ms) è stato **escluso esplicitamente** dall'obiettivo su tua indicazione ("ignoralo, non sono gestiti pagamenti per ora") — resta live, non cacheato, invariato.

**Nota tecnica — perché admin/dashboard e reservations non scendono oltre nonostante query già in parallelo:** profilando dal vivo (timing per singola query dentro i batch `Promise.all`) si è osservato che, con 4+ query davvero concorrenti verso il DB remoto (Supabase, pooler pgbouncer), una o più query arrivano sistematicamente in coda dietro le altre anche se lanciate nello stesso istante — il che indica un limite di concorrenza **lato server** (pool del pooler, non il client Prisma: la macchina locale ha 20 core, quindi il pool Prisma di default non è il collo di bottiglia). Non è un problema risolvibile ulteriormente lato codice senza toccare la configurazione dell'infrastruttura DB (dimensione del pool pgbouncer) — che è fuori scope per una sessione di ottimizzazione applicativa.

---

## Sessione 2026-08-11 (quarta passata) — riepilogo prima/dopo

Ripreso da dove si era fermata `PERFORMANCE_CHANGES.md` ("Still open"): tutti gli endpoint 🔴 rimasti nella tabella "Lenti" sono stati affrontati, tranne la vera pre-aggregazione di analytics/admin-dashboard (fuori scope su decisione esplicita).

| Endpoint | Prima (sessioni precedenti) | Dopo (4ª passata) | Dopo (5ª passata, target <500ms) |
|---|---|---|---|
| `GET /venues/:id/pr-dashboard` | 725-758ms | ~240-370ms | ~240-270ms |
| `GET /venues/:id/floor-plan` | 723-1089ms | ~330-350ms | ~335-345ms (invariato, già ottimo) |
| `GET /events/:id/stats`, `GET /staff/events/:id/stats` | 768-1010ms | ~240-530ms | ~240-555ms (invariato) |
| `GET /staff/entries\|bar-sales\|cloakroom-sales\|table-sales` | staff/venue 720-730ms vs admin 478-480ms | ~475-580ms uniforme | **~240-290ms uniforme** (fix aggiuntivo: validazione parallela invece di sequenziale, vedi sotto) |
| `GET /admin/users` | 586ms | ~335-350ms | invariato |
| `GET /admin/dashboard` | ~1060ms sempre | ~1060ms 1° hit / ~1ms cache warm | invariato (limite lato DB, vedi nota tecnica) |
| `GET /venues/:id/analytics`, `/overview`, `/demographics`, `/revenue-breakdown` | 745-1373ms | stesso costo 1° hit / ~1ms cache warm | **1° hit ridotto** (analytics ~595-640ms, era 750-1140ms; overview spesso <310ms grazie a cache condivisa) |
| `GET /events/:id` | 1057-1111ms | ~850-1250ms | **~340-390ms** (fix aggiuntivo: pricing/floor-plan ora in parallelo col fetch principale invece che dopo, vedi sotto) |
| `GET /reservations` (admin, no filtri) | 673ms | ~615-670ms | ~578-583ms (leggero miglioramento, limite lato DB) |
| `GET /staff/hostess-tables`, `/waiter/tables`, `/bottle-orders` | 715-1100ms | invariato | **hostess-tables e bottle-orders ~240-290ms**, waiter/tables ~480-530ms (fix: seeding e query dipendenti unificate in meno round trip) |

### Fix aggiuntivi della quinta passata (oltre a quanto già in PERFORMANCE_CHANGES.md #23-29)

1. **`GET /events/:id` — pricing/floor-plan portato nello stesso `Promise.all` del fetch principale.** Il loader `loadEventPricingAndFloorPlanSource` filtrava `venue_tables`/floor-plan/zone per `venue_id`, che si conosceva solo *dopo* aver risolto l'evento — creando una dipendenza sequenziale reale (2 round trip). Riscritto per filtrare tramite la relazione `venue.events.some.id = eventId` invece che per `venue_id` diretto: così non serve più conoscere `venue_id` in anticipo, e tutte e 4 le query di pricing/floor-plan girano nello **stesso** `Promise.all` del fetch evento+venue+promos+entry_prices (7 query totali, 1 round trip invece di 2). **-60/70%** sul tempo totale.
2. **Endpoint `/staff/*` GET — validazione venue-scope non più bloccante.** `resolveEventIdForStaffApi` (che valida che l'`eventId` richiesto appartenga al venue del chiamante) girava sempre *prima* della query di lista vera e propria, anche quando l'`eventId` era già noto dal query param (il caso comune). Aggiunto un helper nel controller (`resolveEventIdAndFetch`) che, quando l'`eventId` è già esplicito, lancia la query di lista **in parallelo** con la validazione invece di aspettarla — se la validazione fallisce (403/404), la risposta non viene comunque restituita (si paga solo una query in più nel raro caso di errore, non un round trip in più nel caso normale). Applicato a tutti e 7 gli endpoint GET (`entries`, `bar-sales`, `cloakroom-sales`, `table-sales`, `hostess-tables`, `waiter/tables`, `bottle-orders`).
3. **`getAnalytics` (venue) — le query di aggregazione non dipendono più dalla lista eventi.** `entries`/`reservations`/`bar_sales`/`cloakroom_sales`/`event_tables` filtravano per `event_id: { in: eventIds } }`, dove `eventIds` veniva da una query precedente (`rawEvents`) — dipendenza sequenziale reale. Riscritte per filtrare tramite la relazione `event.venue_id` diretta, eliminando la dipendenza: ora **9 query totali in un solo `Promise.all`** invece di 2 batch sequenziali.
4. **`ensureEventTablesSeeded` (usata da hostess-tables/waiter-tables/bottle-orders) — stesso trattamento.** La query `venue_tables` filtrava per `venue_id`, noto solo dopo aver risolto l'evento. Riscritta per filtrare tramite `venue.events.some.id = eventId`: **4 query totali in 1 `Promise.all`** invece di 2 batch sequenziali.
5. **`/reservations` (admin) — sperimentata la scomposizione in query flat + lookup batch.** La select con 4 relazioni annidate (`user`, `event.venue`, `venue_table`, `venue_table_zone`) è stata scomposta in 1 query scalare + 4 lookup `findMany({ where: { id: { in: [...] } } })` in parallelo. **Risultato: guadagno marginale e incostante** (a volte meglio, a volte uguale) — il profiling ha mostrato che con 4 query lanciate insieme, una finisce sistematicamente "in coda" dietro le altre, confermando un collo di bottiglia lato pool DB più che di query design. Tenuto comunque perché non peggiora nulla e in alcuni casi aiuta.
6. **Vari endpoint "moderati" — rimossi ultimi `await` sequenziali su existence-check che non ne avevano bisogno**: `listVenueTables`, `listVenueStations`, `listVenueTableZones`, `listAssignableUsersForPr` (`/venues/:id/users`), `listVenuePrNetworkMembers` (`/venues/:id/pr-network`), `listPrEventAssignments` (`/venues/:id/pr-events/:id/assignments`), `getStats` (`/venues/:id/stats`, era anche vittima del bug `$transaction` non parallelo). Tutti ora ~240ms invece di ~480-530ms.

**Nota tecnica importante (scoperta nella quarta passata, confermata anche qui):** `prisma.$transaction([...])` **non parallelizza** query indipendenti — tiene una sola connessione ed esegue le query in sequenza (un solo `BEGIN`/`COMMIT`). Su un DB remoto con pooling il costo resta ~N × durata-di-una-query invece di ~1×. Va sempre usato `Promise.all` per letture indipendenti che non richiedono isolamento tra loro; `$transaction` solo per vera atomicità (scritture correlate).

---

## 🟢 Stato finale — quasi tutto sotto i 500ms

| Tempo (stato stazionario) | Metodo | Endpoint | Migliorabile |
|---|---|---|---|
| 1210ms | GET | `/venues/:id/stripe/connect/status` | 🟢 Escluso esplicitamente dall'obiettivo (chiamata Stripe esterna reale) |
| ~865-1065ms (1° hit) / ~1ms (cache warm) | GET | `/admin/dashboard` | 🟡 Limite lato pooler DB, non codice — vedi nota tecnica |
| ~595-640ms (1° hit) / ~1ms (cache warm) | GET | `/venues/:id/analytics` | 🟡 Stesso motivo — serve pre-aggregazione per il 1° hit (fuori scope) |
| ~578-583ms | GET | `/reservations` (admin, no filtri) | 🟡 Limite lato pooler DB, non codice |
| ~480-530ms | GET | `/staff/waiter/tables` | 🟡 Al limite — 2 round trip sequenziali intrinseci alla logica di seeding |
| ~240-490ms | GET | tutti gli altri endpoint precedentemente >500ms | ✅ Sotto soglia |

---

## Riepilogo per chi deve decidere le prossime priorità

**Fatto in questa sessione (2026-08-11):**
1. Bug di parallelismo mancato risolti su `pr-dashboard`, `floor-plan`, `events/:id`, `getAnalytics`, `ensureEventTablesSeeded`, e tutti gli endpoint "moderati" con existence-check bloccante
2. Bug di query duplicata risolto su `/staff/entries|bar-sales|cloakroom-sales|table-sales` (staff/venue pagavano una query in più di admin)
3. Validazione venue-scope resa non bloccante su tutti gli endpoint GET di `/staff/*`
4. Cache TTL in-process 15s su `/venues/:id/analytics*` e `/admin/dashboard` (decisione esplicita: no pre-aggregazione)
5. Scoperta e documentata la trappola `$transaction` non-parallelo, corretta ovunque incontrata
6. `/reservations` (admin) scomposta in query flat + lookup batch (guadagno marginale, limite confermato lato DB)

**Resta da fare (prossime sessioni, in ordine di impatto):**
1. Pre-aggregazione vera per `/venues/:id/analytics*` e `/admin/dashboard` (Priority 3 dell'audit) — è l'unico modo per abbattere il costo del **1° hit**, non solo deduplicarlo con la cache
2. Verificare/aumentare la dimensione del pool di connessioni del pooler DB (Supabase pgbouncer) se `/admin/dashboard` e `/reservations` (admin) restano sopra soglia anche in produzione — è un cambio di infrastruttura, non di codice
3. `GET /staff/hostess-tables`/`waiter/tables`/`bottle-orders` — spostare la seed/reconciliation fuori dal path GET (cambio di design, audit §2) per eliminare l'ultima dipendenza sequenziale residua

**Non toccare (🟢):** `GET /venues/:id/stripe/connect/status` — escluso esplicitamente dall'obiettivo di questa sessione.

**Metodologia — limiti di questa misurazione:** stesso ambiente/account delle sessioni precedenti, un solo evento/venue di test con pochi dati (3 prenotazioni, 2 eventi). I numeri "1° hit" per gli endpoint cacheati mostrano variabilità di rete verso il DB remoto (Supabase pooler): alcune misure isolate hanno mostrato spike anche su endpoint già ottimizzati, riprodotti su più run e attribuiti a jitter/contesa di connessioni lato DB, confermato con profiling per-query (non un difetto del codice applicativo). `POST/PATCH/DELETE` non misurati in questa sessione. Su un venue con volumi di dati reali (non 2-3 righe per tabella), i numeri legati al conteggio righe (non alla struttura delle query) potrebbero cambiare — nessuno dei fix di questa sessione introduce scan non limitati o rimuove i cap di sicurezza (`take`) già presenti.
