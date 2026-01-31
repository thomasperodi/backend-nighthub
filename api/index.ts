import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const server = express();

let app;
let bootstrapPromise: Promise<express.Express> | undefined;

async function bootstrap() {
  if (app) return server;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const nestApp = await NestFactory.create(
      AppModule,
      new ExpressAdapter(server),
    );
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
