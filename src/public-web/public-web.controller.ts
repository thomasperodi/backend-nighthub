import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { computeEventStatus } from '../common/event-time.util';
import {
  APP_LINK_PATHS,
  APP_SCHEME,
  IOS_APP_STORE_ID,
  appStoreUrl,
  iosAppIds,
  playStoreUrl,
} from './public-web.config';
import { renderEventLanding, type LandingEvent } from './pages/event-landing';
import { renderPrivacy, renderTerms } from './pages/legal';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_IMAGE = /^events\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/i;
const pad2 = (n: number) => String(n).padStart(2, '0');
const hhmm = (t: Date | null) =>
  t ? `${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}` : null;

/**
 * Root-level pages (outside `/api`, see PUBLIC_WEB_ROUTES): the iOS universal-link
 * association file, the shareable event page and the legal pages.
 */
@Controller()
@Public()
export class PublicWebController {
  constructor(private readonly prisma: PrismaService) {}

  /** Read by iOS (via Apple's CDN) to let the app open /r/event/* links directly. */
  @Get('.well-known/apple-app-site-association')
  @Header('Content-Type', 'application/json')
  @Header('Cache-Control', 'public, max-age=3600')
  appleAppSiteAssociation() {
    const appIDs = iosAppIds();
    return {
      applinks: {
        // iOS 13+
        details: [
          { appIDs, components: APP_LINK_PATHS.map((path) => ({ '/': path })) },
        ],
      },
    };
  }

  /**
   * Shared event link. With the app installed, iOS opens the app directly and this page is
   * never loaded. Otherwise: event preview (also used by WhatsApp/Instagram link previews)
   * plus the store download button.
   */
  @Get('r/event/:eventId')
  async eventLanding(
    @Param('eventId') eventId: string,
    @Query('pr') pr: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const prCode =
      typeof pr === 'string' && pr.trim() ? pr.trim().slice(0, 64) : null;
    // Behind Vercel's proxy req.protocol is the internal hop (http): use the forwarded one.
    const forwarded = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0]
      .trim();
    const origin = `${forwarded || req.protocol}://${req.get('host')}`;
    const query = prCode ? `?pr=${encodeURIComponent(prCode)}` : '';
    const pageUrl = `${origin}/r/event/${encodeURIComponent(eventId)}${query}`;

    const ua = String(req.headers['user-agent'] || '');
    const platform = /android/i.test(ua)
      ? 'android'
      : /iphone|ipad|ipod/i.test(ua)
        ? 'ios'
        : 'other';

    const event = UUID.test(eventId)
      ? await this.loadEvent(eventId, origin)
      : null;

    res
      .status(event ? 200 : 404)
      // Short cache: the page shows live status (in corso / conclusa / annullata).
      .setHeader('Cache-Control', 'public, max-age=60')
      .type('html')
      .send(
        renderEventLanding({
          event,
          eventId,
          prCode,
          pageUrl,
          platform,
          appStoreUrl: appStoreUrl(),
          playStoreUrl: playStoreUrl(),
          appScheme: APP_SCHEME,
          appStoreId: IOS_APP_STORE_ID,
        }),
      );
  }

  @Get('legal/privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  privacy() {
    return renderPrivacy();
  }

  @Get('legal/termini')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  terms() {
    return renderTerms();
  }

  private async loadEvent(
    id: string,
    origin: string,
  ): Promise<LandingEvent | null> {
    const e = await this.prisma.events.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        image: true,
        date: true,
        start_time: true,
        end_time: true,
        status: true,
        venue: { select: { name: true, city: true } },
      },
    });
    if (!e) return null;

    const image = e.image?.replace(/^\/+/, '') ?? null;
    return {
      id: e.id,
      name: e.name,
      date: e.date
        ? `${e.date.getUTCFullYear()}-${pad2(e.date.getUTCMonth() + 1)}-${pad2(e.date.getUTCDate())}`
        : null,
      startTime: hhmm(e.start_time),
      endTime: hhmm(e.end_time),
      venueName: e.venue?.name ?? null,
      venueCity: e.venue?.city ?? null,
      // Same resized-image proxy the app uses (GET /api/media/...), sized for link previews.
      imageUrl:
        image && EVENT_IMAGE.test(image)
          ? `${origin}/api/media/${image}?w=1080`
          : null,
      status: computeEventStatus(e),
    };
  }
}
