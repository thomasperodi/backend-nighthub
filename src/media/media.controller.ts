import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { MediaService } from './media.service';

/**
 * Resized WebP variants of the public Storage images (event posters, venue photos, avatars).
 * Stand-in for Supabase image transformations (not available on the current plan): the
 * originals can be multi-MB 1080x1920 PNG/JPEG posters, which is far too much for a list
 * thumbnail on mobile data.
 *
 * GET /api/media/:prefix/:file?w=480  (e.g. /api/media/events/<uuid>.jpg?w=480)
 *
 * Object names are random UUIDs and never overwritten, so responses are immutable and
 * cached for a year by the client and by Vercel's CDN (s-maxage): each variant is rendered
 * once per deployment region, not per request. Public and unthrottled on purpose - the
 * images are already public in the bucket, and a screen of posters would otherwise eat
 * into the global per-IP rate limit.
 */
@Controller('media')
@Public()
@SkipThrottle()
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get(':prefix/:file')
  async image(
    @Param('prefix') prefix: string,
    @Param('file') file: string,
    @Query('w') w: string | undefined,
    @Res() res: Response,
  ) {
    const width = this.media.snapWidth(w);
    const { body, contentType } = await this.media.render(prefix, file, width);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, s-maxage=31536000, immutable');
    res.setHeader('Vary', 'Accept-Encoding');
    res.end(body);
  }
}
