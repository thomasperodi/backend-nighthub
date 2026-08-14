// For deploy on vercel (and local dev)
import 'dotenv/config';

import { createApp } from './bootstrap';
import express from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// If Vercel (or another serverless builder) ends up treating this file as the function entrypoint,
// provide a compatible default export handler. The preferred entrypoint remains `api/index.ts`.
const server = express();
let serverlessApp: unknown;
let serverlessBootstrapPromise: Promise<express.Express> | undefined;

async function bootstrapServerless() {
  if (serverlessApp) return server;
  if (serverlessBootstrapPromise) return serverlessBootstrapPromise;

  serverlessBootstrapPromise = (async () => {
    const nestApp = await createApp(new ExpressAdapter(server));
    await nestApp.init();
    serverlessApp = nestApp;
    return server;
  })();

  return serverlessBootstrapPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const srv = await bootstrapServerless();
  srv(req, res);
}

// Some Vercel runtimes load handlers via CommonJS `require()` and treat `module.exports` as the
// "default export". Ensure `require('./main.js')` returns a function (not an object).

(module as any).exports = handler;

async function bootstrap() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  console.log(`Backend listening on http://0.0.0.0:${port}`);
}

// Nest CLI entrypoint for local dev / traditional server deploy.
// Avoid listening when running on Vercel serverless.
// Note: your terminal can have `VERCEL=1` set locally; only skip listen in production.
if (!(process.env.VERCEL && process.env.NODE_ENV === 'production')) {
  void bootstrap();
}
