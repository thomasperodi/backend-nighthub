import { NestFactory } from '@nestjs/core';
import { ValidationPipe, INestApplication } from '@nestjs/common';
import type { AbstractHttpAdapter } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { responseTimingMiddleware } from './common/http/response-timing.middleware';
import { requestContextMiddleware } from './common/http/request-context.middleware';
import { StructuredLogger } from './common/http/structured-logger';
import { AllExceptionsFilter } from './common/http/all-exceptions.filter';
import { resolveCorsOrigins } from './common/cors-origins';

// Single source of truth for app setup, shared by the local/traditional-server entrypoint
// (src/main.ts) and the Vercel serverless entrypoint (api/index.ts). These two used to each
// bootstrap Nest independently and had drifted apart (e.g. the Vercel entrypoint was missing
// the global ValidationPipe and the JSON body-size override) — keeping one function here
// means every entrypoint always gets the same app.
export async function createApp(
  adapter?: AbstractHttpAdapter,
): Promise<INestApplication> {
  const app = adapter
    ? await NestFactory.create(AppModule, adapter, { bodyParser: false })
    : await NestFactory.create(AppModule, { bodyParser: false });

  // Structured (one JSON line per log call) instead of Nest's default pretty console
  // output - applies to every `new Logger(ContextName)` instance app-wide, not just this
  // file (see StructuredLogger's doc comment).
  app.useLogger(new StructuredLogger());

  // Must run before any route/guard so every log line for this request - across every
  // service, however deep the call chain - can be tied back to one request id.
  app.use(requestContextMiddleware());
  app.use(responseTimingMiddleware());
  app.use(cookieParser());

  // Enables class-validator decorators already present on several DTOs (they were previously
  // inert with no pipe registered). `whitelist` is intentionally left off: a few DTOs
  // (events create/update, payments checkout) have no validation decorators yet, and
  // whitelisting would silently strip their fields. Add decorators to those DTOs before
  // enabling whitelist/forbidNonWhitelisted.
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

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

  // OpenAPI document, used as the single source of truth to generate the frontend's typed
  // API client (see pwa/nighthub `npm run generate:api-types`). Kept available in every
  // environment (not just dev) since the frontend's CI needs to fetch it too; it only
  // describes route/DTO shapes, not runtime data, so this is not a sensitive endpoint.
  const openApiDocument = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('NightHub API')
      .setDescription('Auto-generated from DTOs/controllers via the @nestjs/swagger CLI plugin.')
      .setVersion('1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/docs', app, openApiDocument, {
    jsonDocumentUrl: 'api/docs-json',
  });

  // `credentials: true` + an explicit origin list (not '*') is required for the browser to
  // send/receive the httpOnly session cookie. Requests with no Origin header (native/mobile
  // clients using the Authorization: Bearer header instead) are unaffected by this list.
  app.enableCors({
    origin: resolveCorsOrigins(),
    credentials: true,
  });

  return app;
}
