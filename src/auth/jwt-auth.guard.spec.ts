import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from './auth.service';

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: Reflector;
  let authService: {
    verifyAccessToken: jest.Mock;
    touchUserActivity: jest.Mock;
  };

  beforeEach(() => {
    reflector = new Reflector();
    authService = {
      verifyAccessToken: jest.fn(),
      touchUserActivity: jest.fn().mockResolvedValue(undefined),
    };
    guard = new JwtAuthGuard(reflector, authService as unknown as AuthService);
  });

  it('allows @Public() routes without checking for a token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = makeContext({ headers: {} });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authService.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a protected route with no Authorization header', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const ctx = makeContext({ headers: {} });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('accepts a valid Bearer token and attaches req.user', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    authService.verifyAccessToken.mockReturnValue({
      id: 'user-1',
      role: 'client',
      venue_id: null,
    });
    const req: Record<string, unknown> = {
      headers: { authorization: 'Bearer valid-token' },
    };
    const ctx = makeContext(req);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(authService.verifyAccessToken).toHaveBeenCalledWith('valid-token');
    expect(req.user).toEqual({ id: 'user-1', role: 'client', venue_id: null });
  });

  it('propagates rejection for an invalid/expired token', async () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    authService.verifyAccessToken.mockImplementation(() => {
      throw new UnauthorizedException('Invalid token');
    });
    const ctx = makeContext({
      headers: { authorization: 'Bearer bad-token' },
    });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
