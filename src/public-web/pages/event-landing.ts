import { escapeHtml, page } from './layout';

export interface LandingEvent {
  id: string;
  name: string;
  /** YYYY-MM-DD */
  date: string | null;
  /** HH:MM */
  startTime: string | null;
  endTime: string | null;
  venueName: string | null;
  venueCity: string | null;
  /** Absolute URL, or null when the event has no poster. */
  imageUrl: string | null;
  status: 'DRAFT' | 'LIVE' | 'CLOSED' | 'CANCELLED';
}

export interface LandingParams {
  event: LandingEvent | null;
  eventId: string;
  prCode: string | null;
  /** This page's own URL (canonical, og:url, Smart App Banner argument). */
  pageUrl: string;
  platform: 'ios' | 'android' | 'other';
  appStoreUrl: string;
  playStoreUrl: string | null;
  appScheme: string;
  appStoreId: string;
}

const WEEKDAYS = [
  'domenica',
  'lunedì',
  'martedì',
  'mercoledì',
  'giovedì',
  'venerdì',
  'sabato',
];
const MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
];

/** "Sabato 17 ottobre" from YYYY-MM-DD, as a calendar day (no timezone shift). */
export function italianDay(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = WEEKDAYS[date.getUTCDay()];
  return `${weekday[0].toUpperCase()}${weekday.slice(1)} ${d} ${MONTHS[m - 1]}`;
}

function whenLine(e: LandingEvent): string {
  const parts = [e.date ? italianDay(e.date) : null];
  if (e.startTime && e.endTime) parts.push(`${e.startTime}–${e.endTime}`);
  else if (e.startTime) parts.push(`dalle ${e.startTime}`);
  return parts.filter(Boolean).join(' · ');
}

const STATUS_NOTICE: Partial<Record<LandingEvent['status'], string>> = {
  LIVE: 'In corso adesso',
  CLOSED: 'Questa serata è già conclusa',
  CANCELLED: 'Questo evento è stato annullato',
};

export function renderEventLanding(p: LandingParams): string {
  const e = p.event;
  const deepLink = `${p.appScheme}://event/${encodeURIComponent(p.eventId)}${
    p.prCode ? `?pr=${encodeURIComponent(p.prCode)}` : ''
  }`;

  const title = e
    ? `${e.name}${e.venueName ? ` · ${e.venueName}` : ''}`
    : 'NightHub';
  const description = e
    ? [whenLine(e), e.venueCity].filter(Boolean).join(' · ') ||
      'Scopri la serata su NightHub'
    : 'Scopri cosa succede stasera su NightHub';

  // Open Graph / Twitter: what WhatsApp, Instagram and iMessage show when the link is pasted.
  // apple-itunes-app: Safari's native "Open / Get" banner, with this URL passed to the app.
  const head = [
    `<link rel="canonical" href="${escapeHtml(p.pageUrl)}" />`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="NightHub" />`,
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:url" content="${escapeHtml(p.pageUrl)}" />`,
    e?.imageUrl
      ? `<meta property="og:image" content="${escapeHtml(e.imageUrl)}" />`
      : '',
    `<meta name="twitter:card" content="${e?.imageUrl ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="apple-itunes-app" content="app-id=${escapeHtml(p.appStoreId)}, app-argument=${escapeHtml(p.pageUrl)}" />`,
  ].join('\n  ');

  const notice = e ? STATUS_NOTICE[e.status] : null;
  const poster = e?.imageUrl
    ? `<img class="poster" src="${escapeHtml(e.imageUrl)}" alt="Locandina di ${escapeHtml(e.name)}" />`
    : '';

  const eventBlock = e
    ? `${poster}
    ${notice ? `<div class="notice${e.status === 'LIVE' ? ' live' : ''}">${escapeHtml(notice)}</div>` : ''}
    <h1>${escapeHtml(e.name)}</h1>
    <p class="when">${escapeHtml(whenLine(e))}</p>
    ${e.venueName ? `<p class="venue">${escapeHtml(e.venueName)}${e.venueCity ? ` · ${escapeHtml(e.venueCity)}` : ''}</p>` : ''}`
    : `<h1>Serata non trovata</h1>
    <p>Il link potrebbe essere scaduto. Apri NightHub per vedere cosa succede stasera.</p>`;

  const storeButton =
    p.platform === 'android'
      ? p.playStoreUrl
        ? `<a class="btn primary" href="${escapeHtml(p.playStoreUrl)}">Scarica NightHub da Google Play</a>`
        : `<p class="muted center">L'app per Android arriva presto.</p>`
      : `<a class="btn primary" href="${escapeHtml(p.appStoreUrl)}">Scarica NightHub dall'App Store</a>`;

  const prBlock = p.prCode
    ? `<p class="muted center">Invito PR <strong>${escapeHtml(p.prCode)}</strong>. Dopo aver installato l'app, riapri questo link per entrare in lista con il suo invito.</p>`
    : '';

  return page({
    title,
    head,
    extraStyles: `
      .poster { width: 100%; aspect-ratio: 4 / 5; object-fit: cover; border-radius: 18px; background: #101216; margin-bottom: 16px; }
      .notice { display: inline-block; padding: 4px 10px; border-radius: 999px; background: #15181d; color: #f4b860; font-size: 13px; font-weight: 600; margin-bottom: 10px; }
      .notice.live { color: #42c98a; }
      .when { color: #8ea2ff; font-weight: 600; margin: 0 0 4px; }
      .venue { margin: 0 0 24px; }
      .actions { display: grid; gap: 10px; margin-top: 8px; }
      .btn { display: block; text-align: center; text-decoration: none; font-weight: 700; padding: 15px 16px; border-radius: 14px; }
      .btn.primary { background: linear-gradient(90deg, #5b7cff, #7657ff); color: #fff; }
      .btn.secondary { background: #101216; color: #e8eaed; border: 1px solid #23262c; }
      .center { text-align: center; }
    `,
    body: `${eventBlock}
    <div class="actions">
      <a class="btn secondary" href="${escapeHtml(deepLink)}">Ho già l'app: apri in NightHub</a>
      ${storeButton}
    </div>
    ${prBlock}`,
  });
}
