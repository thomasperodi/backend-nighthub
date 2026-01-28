import { createApp } from '../src/main';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import type { VercelRequest, VercelResponse } from '@vercel/node';

let cachedApp: express.Express | null = null;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!cachedApp) {
    const server = express();
    const adapter = new ExpressAdapter(server);

    const app = await createApp(adapter);
    await app.init();

    cachedApp = server;
  }

  cachedApp(req, res);
}
