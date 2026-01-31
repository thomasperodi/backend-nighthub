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

export async function createApp(adapter?: AbstractHttpAdapter) {
  const app = adapter
    ? await NestFactory.create(AppModule, adapter)
    : await NestFactory.create(AppModule);

  app.use(json({ limit: '15mb' }));
  app.use(urlencoded({ extended: true, limit: '15mb' }));

  app.setGlobalPrefix('api');
  app.enableCors();

  return app;
}

async function bootstrap() {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  console.log(`Backend listening on http://0.0.0.0:${port}`);
}

// Nest CLI entrypoint for local dev
void bootstrap();
