import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PublicWebController } from './public-web.controller';
import { PUBLIC_WEB_ROUTES } from './public-web.config';
import { PrismaService } from '../prisma/prisma.service';

// Same prefix setup as bootstrap.ts: these pages must answer at the domain root (iOS only
// reads /.well-known/ there), not under /api.
describe('PublicWeb routing', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PublicWebController],
      providers: [
        {
          provide: PrismaService,
          useValue: {
            events: { findUnique: jest.fn().mockResolvedValue(null) },
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api', { exclude: PUBLIC_WEB_ROUTES });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the association file at the root as JSON', async () => {
    const res = await request(app.getHttpServer())
      .get('/.well-known/apple-app-site-association')
      .expect(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = res.body as { applinks: { details: { appIDs: string[] }[] } };
    expect(body.applinks.details[0].appIDs).toEqual([
      '4S4XRSW6AC.com.thomas88.nighthub',
    ]);
  });

  it('serves the event page (with a path param) and the legal pages at the root', async () => {
    const server = app.getHttpServer();
    await request(server)
      .get('/r/event/6968f5c3-6c0a-4779-bd40-18be45db00af?pr=X')
      .expect(404)
      .expect('Content-Type', /html/);
    await request(server).get('/legal/privacy').expect(200);
    await request(server).get('/legal/termini').expect(200);
    await request(server).get('/supporto').expect(200);
    await request(server).get('/support').expect(200);
  });

  it('does not serve them under /api', async () => {
    await request(app.getHttpServer()).get('/api/legal/privacy').expect(404);
  });
});
