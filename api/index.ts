import 'dotenv/config';

import { createApp } from '../src/bootstrap';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const server = express();

let app: unknown;
let bootstrapPromise: Promise<express.Express> | undefined;

async function bootstrap() {
  if (app) return server;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const nestApp = await createApp(new ExpressAdapter(server));
    await nestApp.init();
    app = nestApp;
    return server;
  })();

  return bootstrapPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const server = await bootstrap();
  server(req, res);
}
