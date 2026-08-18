import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService, REFRESH_COOKIE_NAME } from './auth.service';

function makeRes() {
  const cookie = jest.fn();
  const clearCookie = jest.fn();
  const res = { cookie, clearCookie } as unknown as Response;
  return { res, cookie, clearCookie };
}

function makeReq(cookies: Record<string, string> = {}): Request {
  return {
    headers: { 'user-agent': 'jest' },
    cookies,
    ip: '127.0.0.1',
  } as unknown as Request;
}

describe('AuthController', () => {
  let controller: AuthController;
  let authService: {
    register: jest.Mock;
    login: jest.Mock;
    refreshSession: jest.Mock;
    logout: jest.Mock;
    listSessions: jest.Mock;
    revokeSessionById: jest.Mock;
    revokeAllSessions: jest.Mock;
    deleteUser: jest.Mock;
  };

  beforeEach(async () => {
    authService = {
      register: jest.fn(),
      login: jest.fn(),
      refreshSession: jest.fn(),
      logout: jest.fn(),
      listSessions: jest.fn(),
      revokeSessionById: jest.fn(),
      revokeAllSessions: jest.fn(),
      deleteUser: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('register: auto-logs-in the new user, same session shape as login (public endpoint)', async () => {
    authService.register.mockResolvedValue({
      accessToken: 'new-user-access-token',
      refreshToken: 'new-user-refresh-token',
      refreshTokenExpiresAt: new Date(),
      user: { id: 'u1' },
    });

    const dto = {
      email: 'a@b.com',
      username: 'a',
      password: 'password123',
      name: 'A',
    } as any;
    const { res, cookie } = makeRes();
    const result = await controller.register(dto, makeReq(), res);

    expect(authService.register).toHaveBeenCalledWith(dto, expect.any(Object));
    expect(cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      'new-user-refresh-token',
      expect.any(Object),
    );
    expect(result).toEqual({
      access_token: 'new-user-access-token',
      user: { id: 'u1' },
    });
  });

  it('login: sets the refresh cookie and never returns the raw refresh token in the body', async () => {
    authService.login.mockResolvedValue({
      accessToken: 'access-token-value',
      refreshToken: 'refresh-token-value',
      refreshTokenExpiresAt: new Date(),
      user: { id: 'u1' },
    });
    const { res, cookie } = makeRes();

    const body = await controller.login(
      { identifier: 'a', password: 'b' } as any,
      makeReq(),
      res,
    );

    expect(cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      'refresh-token-value',
      expect.objectContaining({ httpOnly: true, path: '/api/auth' }),
    );
    expect(body).toEqual({
      access_token: 'access-token-value',
      user: { id: 'u1' },
    });
    expect(JSON.stringify(body)).not.toContain('refresh-token-value');
  });

  it('login: propagates the 401 and sets no cookie on invalid credentials', async () => {
    authService.login.mockRejectedValue(new UnauthorizedException('Credenziali non valide'));
    const { res, cookie } = makeRes();

    await expect(
      controller.login({ identifier: 'a', password: 'wrong' } as any, makeReq(), res),
    ).rejects.toThrow(UnauthorizedException);
    expect(cookie).not.toHaveBeenCalled();
  });

  it('refresh: reads the refresh token exclusively from the cookie', async () => {
    authService.refreshSession.mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      refreshTokenExpiresAt: new Date(),
      user: { id: 'u1' },
    });
    const { res, cookie } = makeRes();
    const req = makeReq({ [REFRESH_COOKIE_NAME]: 'old-refresh-token' });

    const body = await controller.refresh(req, res);

    expect(authService.refreshSession).toHaveBeenCalledWith(
      'old-refresh-token',
      expect.any(Object),
    );
    expect(cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      'new-refresh-token',
      expect.any(Object),
    );
    expect(body).toEqual({
      access_token: 'new-access-token',
      user: { id: 'u1' },
    });
  });

  it('logout: revokes the session from the cookie and clears the cookie', async () => {
    authService.logout.mockResolvedValue({ success: true });
    const { res, clearCookie } = makeRes();
    const req = makeReq({ [REFRESH_COOKIE_NAME]: 'some-refresh-token' });

    const result = await controller.logout(req, res);

    expect(authService.logout).toHaveBeenCalledWith('some-refresh-token');
    expect(clearCookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      expect.objectContaining({ path: '/api/auth' }),
    );
    expect(result).toEqual({ success: true });
  });

  it('revokeSession: scopes the revoke call to the current user', async () => {
    authService.revokeSessionById.mockResolvedValue({ success: true });

    await controller.revokeSession('session-42', { id: 'u1', role: 'client' });

    expect(authService.revokeSessionById).toHaveBeenCalledWith(
      'u1',
      'session-42',
    );
  });

  it("revokeAllSessions: excludes the caller's own current session", async () => {
    authService.revokeAllSessions.mockResolvedValue({ success: true });
    const req = makeReq({ [REFRESH_COOKIE_NAME]: 'current-token' });

    await controller.revokeAllSessions(req, { id: 'u1', role: 'client' });

    expect(authService.revokeAllSessions).toHaveBeenCalledWith(
      'u1',
      'current-token',
    );
  });
});
