import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ExpressAdapter } from '@nestjs/platform-express';
import express from 'express';

const server = express();

let app;

async function bootstrap() {
  if (!app) {
    const nestApp = await NestFactory.create(
      AppModule,
      new ExpressAdapter(server),
    );
    await nestApp.init();
    app = nestApp;
  }
  return server;
}

export default async function handler(req, res) {
  const server = await bootstrap();
  server(req, res);
}
