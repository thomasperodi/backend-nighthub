import { BadRequestException, Injectable } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

type PublicImagePrefix = 'events' | 'users' | 'venues';

@Injectable()
export class SupabaseStorageService {
  private client?: ReturnType<typeof createClient>;
  private readonly bucketPublic: string;

  constructor() {
    this.bucketPublic =
      process.env.SUPABASE_BUCKET_PUBLIC ||
      process.env.SUPABASE_BUCKET_EVENTS ||
      'event-posters';

    const url = String(
      process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL || '',
    ).trim();
    const serviceRoleKey = String(
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.EXPO_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ||
        '',
    ).trim();
    if (url && serviceRoleKey) {
      this.client = createClient(url, serviceRoleKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
    }
  }

  private ensureClient() {
    if (this.client) return this.client;
    throw new BadRequestException(
      'Supabase Storage not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)',
    );
  }

  private normalizeExt(ext?: string): string {
    const extRaw = (ext || 'jpg').replace(/^\./, '').toLowerCase();
    const allowed = new Set(['png', 'jpg', 'jpeg', 'webp']);
    return allowed.has(extRaw) ? extRaw : 'jpg';
  }

  private buildObjectPath(prefix: PublicImagePrefix, ext?: string): string {
    return `${prefix}/${randomUUID()}.${this.normalizeExt(ext)}`;
  }

  async createSignedUploadForPublicImage(params: {
    prefix: PublicImagePrefix;
    ext?: string;
    contentType?: string;
  }): Promise<{
    bucket: string;
    path: string;
    token: string;
    signedUrl: string;
  }> {
    const client = this.ensureClient();
    void params.contentType;

    const objectPath = this.buildObjectPath(params.prefix, params.ext);

    const { data, error } = await client.storage
      .from(this.bucketPublic)
      .createSignedUploadUrl(objectPath);

    if (error || !data?.signedUrl || !data?.token) {
      throw new BadRequestException(
        `Failed to create signed upload URL: ${error?.message || 'unknown error'}`,
      );
    }

    return {
      bucket: this.bucketPublic,
      path: objectPath,
      token: data.token,
      signedUrl: data.signedUrl,
    };
  }

  uploadPublicImageFromDataUrl(params: {
    prefix: PublicImagePrefix;
    input: string;
  }): {
    pathPromise: Promise<string>;
  } {
    const { input, prefix } = params;
    if (!input) {
      throw new BadRequestException('image is empty');
    }

    const match = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
    if (!match) {
      throw new BadRequestException(
        'image must be a data URL (data:<mime>;base64,...)',
      );
    }

    const mime = match[1].toLowerCase();
    const base64 = match[2];

    let ext = 'jpg';
    if (mime === 'image/png') ext = 'png';
    else if (mime === 'image/webp') ext = 'webp';
    else if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';

    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) {
      throw new BadRequestException('image is not valid base64');
    }

    const maxBytes = 6 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      throw new BadRequestException('image is too large (max 6MB)');
    }

    const objectPath = this.buildObjectPath(prefix, ext);

    return {
      pathPromise: this.uploadBuffer(
        this.bucketPublic,
        objectPath,
        buffer,
        mime,
      ).then(() => objectPath),
    };
  }

  uploadPublicImageFromBuffer(params: {
    prefix: PublicImagePrefix;
    buffer: Buffer;
    contentType: string;
    ext?: string;
  }): { pathPromise: Promise<string> } {
    const { prefix, buffer, contentType } = params;

    if (!buffer?.length) {
      throw new BadRequestException('file is empty');
    }

    const maxBytes = 6 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      throw new BadRequestException('image is too large (max 6MB)');
    }

    const objectPath = this.buildObjectPath(prefix, params.ext);
    return {
      pathPromise: this.uploadBuffer(
        this.bucketPublic,
        objectPath,
        buffer,
        contentType,
      ).then(() => objectPath),
    };
  }

  async deletePublicImage(path?: string | null): Promise<void> {
    if (!path) return;

    const normalizedPath = path.trim().replace(/^\/+/, '');
    if (
      !normalizedPath ||
      /^(https?:)?\/\//i.test(normalizedPath) ||
      normalizedPath.startsWith('data:')
    ) {
      return;
    }

    const client = this.ensureClient();
    const { error } = await client.storage
      .from(this.bucketPublic)
      .remove([normalizedPath]);

    if (error && !/not found/i.test(error.message || '')) {
      throw new BadRequestException(`Failed to delete image: ${error.message}`);
    }
  }

  async createSignedUploadForEventPoster(params?: {
    ext?: string;
    contentType?: string;
  }): Promise<{
    bucket: string;
    path: string;
    token: string;
    signedUrl: string;
  }> {
    return this.createSignedUploadForPublicImage({
      prefix: 'events',
      ext: params?.ext,
      contentType: params?.contentType,
    });
  }

  uploadEventPosterFromDataUrl(input: string): {
    pathPromise: Promise<string>;
  } {
    return this.uploadPublicImageFromDataUrl({
      prefix: 'events',
      input,
    });
  }

  uploadEventPosterFromBuffer(params: {
    buffer: Buffer;
    contentType: string;
    ext?: string;
  }): { pathPromise: Promise<string> } {
    return this.uploadPublicImageFromBuffer({
      prefix: 'events',
      buffer: params.buffer,
      contentType: params.contentType,
      ext: params.ext,
    });
  }

  private async uploadBuffer(
    bucket: string,
    path: string,
    buffer: Buffer,
    contentType: string,
  ): Promise<void> {
    const client = this.ensureClient();

    const { error } = await client.storage.from(bucket).upload(path, buffer, {
      contentType,
      upsert: true,
    });

    if (error) {
      throw new BadRequestException(`Failed to upload image: ${error.message}`);
    }
  }
}
