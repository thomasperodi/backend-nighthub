import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

// Exercises the actual @Throttle() override on POST /auth/login end-to-end (real HTTP layer,
// real ThrottlerGuard) rather than asserting decorator metadata, so this fails if the
// route's rate limit is ever accidentally removed or loosened.
describe('Rate limiting on sensitive auth endpoints', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 120 }]),
      ],
      controllers: [AuthController],
      providers: [
        {
          provide: AuthService,
          useValue: { login: jest.fn().mockResolvedValue(null) },
        },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 429 once the per-route login limit (10/min) is exceeded', async () => {
    const agent = request(app.getHttpServer());
    const statuses: number[] = [];

    for (let i = 0; i < 11; i++) {
      const res = await agent
        .post('/auth/login')
        .send({ identifier: 'someone', password: 'irrelevant' });
      statuses.push(res.status);
    }

    // First 10 requests are within the limit (200/201 - login itself returns null body but
    // 2xx status since credentials are wrong, not rate-limited); the 11th must be throttled.
    expect(statuses.slice(0, 10).every((s) => s < 429)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
