import 'dotenv/config';

import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

function parseDataUrl(input: string): {
  mime: string;
  buffer: Buffer;
  ext: string;
} {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(input.trim());
  if (!match) throw new Error('Not a data URL');
  const mime = match[1].toLowerCase();
  const base64 = match[2];

  let ext = 'jpg';
  if (mime === 'image/png') ext = 'png';
  else if (mime === 'image/webp') ext = 'webp';
  else if (mime === 'image/jpeg' || mime === 'image/jpg') ext = 'jpg';

  const buffer = Buffer.from(base64, 'base64');
  return { mime, buffer, ext };
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_BUCKET_EVENTS || 'event-posters';

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const prisma = new PrismaClient({ log: ['error'] });

  const events = await prisma.events.findMany({
    where: {
      image: {
        startsWith: 'data:image/',
      },
    },
    select: { id: true, image: true },
  });

  console.log(`[migrate] found ${events.length} events with data URL image`);

  for (const e of events) {
    if (!e.image) continue;

    const { mime, buffer, ext } = parseDataUrl(e.image);
    const path = `events/${randomUUID()}.${ext}`;

    const { error } = await supabase.storage.from(bucket).upload(path, buffer, {
      contentType: mime,
      upsert: true,
    });

    if (error) {
      console.error(
        `[migrate] upload failed for event ${e.id}:`,
        error.message,
      );
      continue;
    }

    await prisma.events.update({
      where: { id: e.id },
      data: { image: path },
    });

    console.log(`[migrate] event ${e.id} -> ${path}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
