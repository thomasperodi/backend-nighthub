import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CsrfOriginGuard } from './csrf-origin.guard';

function makeContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('CsrfOriginGuard', () => {
  const guard = new CsrfOriginGuard();
  const originalEnv = process.env.CORS_ORIGINS;

  beforeEach(() => {
    process.env.CORS_ORIGINS = 'https://app.nighthub.it';
  });

  afterAll(() => {
    process.env.CORS_ORIGINS = originalEnv;
  });

  it('allows requests with no Origin/Referer header (non-browser clients)', () => {
    expect(guard.canActivate(makeContext({}))).toBe(true);
  });

  it('allows a request whose Origin is in the CORS allow-list', () => {
    const ctx = makeContext({ origin: 'https://app.nighthub.it' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects a request whose Origin is not in the CORS allow-list', () => {
    const ctx = makeContext({ origin: 'https://evil.example.com' });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('falls back to Referer when Origin is absent', () => {
    const ok = makeContext({
      referer: 'https://app.nighthub.it/some/page',
    });
    expect(guard.canActivate(ok)).toBe(true);

    const bad = makeContext({
      referer: 'https://evil.example.com/some/page',
    });
    expect(() => guard.canActivate(bad)).toThrow(ForbiddenException);
  });
});
