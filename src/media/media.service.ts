import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type Sharp from 'sharp';

// Loaded on first use, not at boot: only image requests need it, and every cold start on
// Vercel would otherwise pay for the native module even for plain JSON calls.
let sharpModule: typeof Sharp | undefined;
function sharp(...args: Parameters<typeof Sharp>) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sharpModule ??= require('sharp') as typeof Sharp;
  return sharpModule(...args);
}

// Only the public image prefixes SupabaseStorageService writes to. The object name is always
// `<uuid>.<ext>` (see SupabaseStorageService.buildObjectPath), so anything else is rejected
// before any network call - the upstream URL is built from a fixed base, never from input.
const ALLOWED_PREFIXES = new Set([
  'events',
  'venues',
  'users',
  'venue-wallet-logos',
]);
const FILE_RE = /^[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/i;

// Widths are snapped to a small fixed set so the CDN cache holds a bounded number of
// variants per image (and nobody can make us render arbitrary sizes).
export const MEDIA_WIDTHS = [160, 320, 480, 720, 1080] as const;
const DEFAULT_WIDTH = 720;

// Per-instance memory cache: on Vercel the CDN (s-maxage) is the real cache, this only
// saves work on a warm instance / in local development.
const MEMORY_CACHE_MAX_BYTES = 40 * 1024 * 1024;

export interface RenderedImage {
  body: Buffer;
  contentType: string;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly cache = new Map<string, RenderedImage>();
  private cacheBytes = 0;
  private readonly inFlight = new Map<string, Promise<RenderedImage>>();

  private get publicBase(): string {
    const url = String(
      process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '',
    )
      .trim()
      .replace(/\/+$/, '');
    const bucket =
      process.env.SUPABASE_BUCKET_PUBLIC ||
      process.env.SUPABASE_BUCKET_EVENTS ||
      'event-posters';
    return `${url}/storage/v1/object/public/${bucket}`;
  }

  snapWidth(raw: unknown): number {
    const w = Number(raw);
    if (!Number.isFinite(w) || w <= 0) return DEFAULT_WIDTH;
    return (
      MEDIA_WIDTHS.find((allowed) => allowed >= w) ??
      MEDIA_WIDTHS[MEDIA_WIDTHS.length - 1]
    );
  }

  assertValidPath(prefix: string, file: string) {
    if (!ALLOWED_PREFIXES.has(prefix) || !FILE_RE.test(file)) {
      throw new NotFoundException('Image not found');
    }
  }

  async render(
    prefix: string,
    file: string,
    width: number,
  ): Promise<RenderedImage> {
    this.assertValidPath(prefix, file);
    const key = `${prefix}/${file}@${width}`;

    const cached = this.cache.get(key);
    if (cached) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.renderUncached(prefix, file, width).finally(() =>
        this.inFlight.delete(key),
      );
      this.inFlight.set(key, pending);
    }
    const rendered = await pending;
    this.remember(key, rendered);
    return rendered;
  }

  private async renderUncached(
    prefix: string,
    file: string,
    width: number,
  ): Promise<RenderedImage> {
    const res = await fetch(`${this.publicBase}/${prefix}/${file}`);
    if (res.status === 400 || res.status === 404)
      throw new NotFoundException('Image not found');
    if (!res.ok)
      throw new Error(`Storage responded ${res.status} for ${prefix}/${file}`);

    const input = Buffer.from(await res.arrayBuffer());
    try {
      const body = await sharp(input, { failOn: 'none' })
        .rotate() // honour EXIF orientation from phone photos
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 78, effort: 4, smartSubsample: true })
        .toBuffer();
      return { body, contentType: 'image/webp' };
    } catch (error) {
      // Not decodable by sharp: serve the original bytes rather than a broken image.
      this.logger.warn(
        `Could not optimize ${prefix}/${file}: ${String(error)}`,
      );
      return {
        body: input,
        contentType:
          res.headers.get('content-type') || 'application/octet-stream',
      };
    }
  }

  private remember(key: string, value: RenderedImage) {
    if (this.cache.has(key) || value.body.length > MEMORY_CACHE_MAX_BYTES / 4)
      return;
    this.cache.set(key, value);
    this.cacheBytes += value.body.length;
    while (this.cacheBytes > MEMORY_CACHE_MAX_BYTES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cacheBytes -= this.cache.get(oldest)!.body.length;
      this.cache.delete(oldest);
    }
  }
}
