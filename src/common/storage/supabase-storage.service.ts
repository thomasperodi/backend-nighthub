import { BadRequestException, Injectable } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

@Injectable()
export class SupabaseStorageService {
  private client?: ReturnType<typeof createClient>;
  private readonly bucketEvents: string;

  constructor() {
    this.bucketEvents = process.env.SUPABASE_BUCKET_EVENTS || 'event-posters';

    const url = process.env.SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

  async createSignedUploadForEventPoster(params?: {
    ext?: string;
    contentType?: string;
  }): Promise<{ bucket: string; path: string; token: string; signedUrl: string }> {
    const client = this.ensureClient();

    const extRaw = (params?.ext || 'jpg').replace(/^\./, '').toLowerCase();
    const allowed = new Set(['png', 'jpg', 'jpeg', 'webp']);
    const ext = allowed.has(extRaw) ? extRaw : 'jpg';

    const objectPath = `events/${randomUUID()}.${ext}`;

    const { data, error } = await client.storage
      .from(this.bucketEvents)
      .createSignedUploadUrl(objectPath);

    if (error || !data?.signedUrl || !data?.token) {
      throw new BadRequestException(
        `Failed to create signed upload URL: ${error?.message || 'unknown error'}`,
      );
    }

    return {
      bucket: this.bucketEvents,
      path: objectPath,
      token: data.token,
      signedUrl: data.signedUrl,
    };
  }

  uploadEventPosterFromDataUrl(input: string): {
    pathPromise: Promise<string>;
  } {
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

    // Hard limit to protect DB/API from huge base64 payloads
    const maxBytes = 6 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      throw new BadRequestException('image is too large (max 6MB)');
    }

    const objectPath = `events/${randomUUID()}.${ext}`;

    return {
      pathPromise: this.uploadBuffer(
        this.bucketEvents,
        objectPath,
        buffer,
        mime,
      ).then(() => objectPath),
    };
  }

  uploadEventPosterFromBuffer(params: {
    buffer: Buffer;
    contentType: string;
    ext?: string;
  }): { pathPromise: Promise<string> } {
    const { buffer, contentType } = params;
    const ext = (params.ext || 'jpg').replace(/^\./, '').toLowerCase();

    if (!buffer?.length) {
      throw new BadRequestException('file is empty');
    }

    const maxBytes = 6 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      throw new BadRequestException('image is too large (max 6MB)');
    }

    const objectPath = `events/${randomUUID()}.${ext}`;
    return {
      pathPromise: this.uploadBuffer(
        this.bucketEvents,
        objectPath,
        buffer,
        contentType,
      ).then(() => objectPath),
    };
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
