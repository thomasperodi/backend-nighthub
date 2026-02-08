// import { NestFactory } from '@nestjs/core';
// import { AppModule } from './app.module';
// import { json, urlencoded } from 'express';

// async function bootstrap() {
//   const app = await NestFactory.create(AppModule);

//   // Allow larger payloads (e.g., base64 posters)
//   app.use(json({ limit: '15mb' }));
//   app.use(urlencoded({ extended: true, limit: '15mb' }));

//   // Tutte le rotte partiranno da /api
//   app.setGlobalPrefix('api');

//   // Ascolta su tutti gli IP della rete locale
//   await app.listen(process.env.PORT ?? 3000, '0.0.0.0');

//   console.log(
//     `Backend in ascolto su http://0.0.0.0:${process.env.PORT ?? 3000}/api`,
//   );
// }
// // Use void to explicitly ignore the returned promise for linting
// void bootstrap();

// For deploy on vercel (and local dev)
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';
import type { AbstractHttpAdapter } from '@nestjs/core';
import { responseTimingMiddleware } from './common/http/response-timing.middleware';
import express from 'express';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { VercelRequest, VercelResponse } from '@vercel/node';

async function createApp(adapter?: AbstractHttpAdapter) {
  const app = adapter
    ? await NestFactory.create(AppModule, adapter, { bodyParser: false })
    : await NestFactory.create(AppModule, { bodyParser: false });

  app.use(responseTimingMiddleware());

  app.use((req, res, next) => {
    // Quick check to ensure the deployed instance is running the expected body limit.
    // If you still see 413 with limit=102400 in logs, Vercel is serving an older build.
    res.setHeader('X-Json-Limit', '5mb');
    next();
  });

  // Increase JSON body limit (Nest default is 100kb). Posters should go via /events/poster.
  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ extended: true, limit: '5mb' }));

  app.setGlobalPrefix('api');
  app.enableCors();

  return app;
}

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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(module as any).exports = handler;

async function bootstrap() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`Backend listening on http://0.0.0.0:${port}`);
}

// Nest CLI entrypoint for local dev / traditional server deploy.
// Avoid listening when running on Vercel serverless.
// Note: your terminal can have `VERCEL=1` set locally; only skip listen in production.
if (!(process.env.VERCEL && process.env.NODE_ENV === 'production')) {
  void bootstrap();
}
