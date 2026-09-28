import 'dotenv/config';

import { createApp } from '../src/bootstrap';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Same one-JSON-line format as StructuredLogger, usable before Nest (and its logger) exists.
function log(level: 'log' | 'warn' | 'error', message: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    context: 'VercelHandler',
    message,
    ...extra,
  });
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

function errorFields(error: unknown) {
  return error instanceof Error
    ? { error: error.message, name: error.name, stack: error.stack }
    : { error: String(error) };
}

process.on('unhandledRejection', (reason) => {
  log('error', 'unhandledRejection', errorFields(reason));
});
process.on('uncaughtException', (error) => {
  log('error', 'uncaughtException', errorFields(error));
});

const instanceStartedAt = Date.now();
log('log', 'Cold start', {
  region: process.env.VERCEL_REGION,
  node: process.version,
  commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7),
});

const server = express();

let app: unknown;
let bootstrapPromise: Promise<express.Express> | undefined;

async function bootstrap() {
  if (app) return server;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const start = Date.now();
    try {
      const nestApp = await createApp(new ExpressAdapter(server));
      await nestApp.init();
      app = nestApp;
      log('log', 'Nest bootstrap completed', {
        durationMs: Date.now() - start,
        sinceColdStartMs: Date.now() - instanceStartedAt,
      });
      return server;
    } catch (error) {
      // Don't cache the rejected promise: without this reset every later request on this
      // instance would fail with the same bootstrap error instead of retrying.
      bootstrapPromise = undefined;
      log('error', 'Nest bootstrap failed', {
        durationMs: Date.now() - start,
        ...errorFields(error),
      });
      throw error;
    }
  })();

  return bootstrapPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  let server: express.Express;
  try {
    server = await bootstrap();
  } catch (error) {
    log('error', 'Request failed: app not bootstrapped', {
      method: req.method,
      path: req.url?.split('?')[0],
    });
    if (!res.headersSent) {
      res.status(500).json({ statusCode: 500, message: 'Internal server error' });
    }
    return;
  }
  server(req, res);
}
