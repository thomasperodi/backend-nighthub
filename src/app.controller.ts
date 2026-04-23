import { Controller, Get, Param, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppService } from './app.service';
import { Public } from './auth/public.decorator';

@Controller()
@Public()
export class AppController {
  constructor(private readonly appService: AppService) {}

  private normalizeBaseUrl(value: string | undefined, fallback: string): string {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return withProtocol.replace(/\/+$/, '');
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  health(): { status: string } {
    return { status: 'ok' };
  }

  @Get('r/event/:eventId')
  redirectToEvent(
    @Param('eventId') eventId: string,
    @Query('pr') pr?: string,
    @Query('wallet') wallet?: string,
    @Req() req?: Request,
    @Res() res?: Response,
  ) {
    if (!res) return;

    const encodedEventId = encodeURIComponent(String(eventId || '').trim());
    const query = new URLSearchParams();
    if (typeof pr === 'string' && pr.trim().length > 0) query.set('pr', pr.trim());
    if (wallet === 'apple' || wallet === 'google') query.set('wallet', wallet);

    const queryString = query.toString();
    const querySuffix = queryString ? `?${queryString}` : '';

    const deepLink = `nighthub://event/${encodedEventId}${querySuffix}`;

    const appBase = this.normalizeBaseUrl(
      process.env.EXPO_PUBLIC_APP_SHARE_URL || process.env.EXPO_PUBLIC_APP_BASE_URL,
      'https://nighthub.app',
    );
    const webUrl = `${appBase}/event/${encodedEventId}${querySuffix}`;

    const androidStoreUrl = this.normalizeBaseUrl(
      process.env.EXPO_PUBLIC_PLAY_STORE_URL,
      'https://play.google.com/store/apps/details?id=com.perodithomas.nighthub',
    );
    const iosStoreUrl = this.normalizeBaseUrl(
      process.env.EXPO_PUBLIC_APP_STORE_URL,
      androidStoreUrl,
    );

    const ua = String(req?.headers['user-agent'] || '').toLowerCase();
    const isAndroid = ua.includes('android');
    const storeUrl = isAndroid ? androidStoreUrl : iosStoreUrl;

    const safeDeepLink = this.escapeHtml(deepLink);
    const safeStoreUrl = this.escapeHtml(storeUrl);
    const safeWebUrl = this.escapeHtml(webUrl);
    const safeIosStoreUrl = this.escapeHtml(iosStoreUrl);
    const safeAndroidStoreUrl = this.escapeHtml(androidStoreUrl);

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.status(200).type('html').send(`<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Apri NightHub</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #0f1115; color: #f3f4f6; }
    .wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    .card { width: min(520px, 100%); background: #171923; border: 1px solid #2a2f3b; border-radius: 16px; padding: 18px; }
    h1 { font-size: 20px; margin: 0 0 10px; }
    p { margin: 0 0 14px; color: #c2c8d3; line-height: 1.5; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; }
    a { text-decoration: none; border-radius: 10px; padding: 10px 12px; font-weight: 700; }
    a.primary { background: #53d3ff; color: #081018; }
    a.secondary { background: #252b39; color: #f3f4f6; border: 1px solid #323a4c; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Apertura NightHub...</h1>
      <p>Sto provando ad aprire l'app. Se non e installata, verrai reindirizzato automaticamente allo store.</p>
      <div class="row">
        <a class="primary" href="${safeDeepLink}">Apri app</a>
        <a class="secondary" href="${safeStoreUrl}">Apri store</a>
        <a class="secondary" href="${safeWebUrl}">Apri web</a>
        <a class="secondary" href="${safeIosStoreUrl}">App Store iOS</a>
        <a class="secondary" href="${safeAndroidStoreUrl}">Google Play</a>
      </div>
    </div>
  </div>
  <script>
    const deepLink = ${JSON.stringify(deepLink)};
    const storeUrl = ${JSON.stringify(storeUrl)};
    let switched = false;
    const start = Date.now();

    const fallback = () => {
      if (switched) return;
      const elapsed = Date.now() - start;
      if (elapsed < 900) {
        window.location.replace(storeUrl);
      }
    };

    window.addEventListener('blur', () => { switched = true; });
    window.addEventListener('pagehide', () => { switched = true; });
    window.location.replace(deepLink);
    setTimeout(fallback, 1100);
  </script>
</body>
</html>`);
  }
}
