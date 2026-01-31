import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { responseTimingMiddleware } from '../src/common/http/response-timing.middleware';

const server = express();

server.use(responseTimingMiddleware());
server.use((req, res, next) => {
  res.setHeader('X-Json-Limit', '5mb');
  next();
});
// Increase JSON body limit (Nest default is 100kb) to avoid PayloadTooLargeError.
// Posters are uploaded via multipart on /events/poster, so JSON payloads should remain small.
server.use(express.json({ limit: '5mb' }));
server.use(express.urlencoded({ extended: true, limit: '5mb' }));

let app;
let bootstrapPromise: Promise<express.Express> | undefined;

async function bootstrap() {
  if (app) return server;
  if (bootstrapPromise) return bootstrapPromise;

  bootstrapPromise = (async () => {
    const nestApp = await NestFactory.create(
      AppModule,
      new ExpressAdapter(server),
      {
        bodyParser: false,
      },
    );

    nestApp.enableCors();
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
