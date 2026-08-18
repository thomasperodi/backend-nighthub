import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcrypt';
import { Prisma, UserRole } from '@prisma/client';

// Real JwtService (not mocked) so sign()/verify() exercise actual JWT behaviour - the
// refresh-token store is what we mock, since that's the part backed by Prisma.
const TEST_JWT_SECRET = 'unit-test-secret';
// bcrypt's own type declarations resolve to `any`, same as AuthService's own cast.
const bcryptHash = hash as (s: string, rounds: number) => Promise<string>;

function makePrismaMock() {
  return {
    users: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      delete: jest.fn(),
    },
    refresh_tokens: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    used_password_reset_tokens: {
      create: jest.fn(),
    },
    venue_pr_memberships: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof makePrismaMock>;

  const baseUser = {
    id: 'user-1',
    email: 'user@example.com',
    username: 'user1',
    password_hash: '',
    role: UserRole.client,
    name: 'User One',
    avatar: null,
    is_active: true,
    venue_id: null,
    created_at: new Date('2026-01-01'),
  };

  beforeEach(async () => {
    prisma = makePrismaMock();
    prisma.users.updateMany.mockResolvedValue({ count: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: JwtService,
          useValue: new JwtService({ secret: TEST_JWT_SECRET }),
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('login', () => {
    it('returns access + refresh token on correct credentials', async () => {
      const passwordHash = await bcryptHash('correct-password', 10);
      prisma.users.findFirst.mockResolvedValue({
        ...baseUser,
        password_hash: passwordHash,
      });
      prisma.refresh_tokens.create.mockResolvedValue({ id: 'session-1' });

      const result = await service.login({
        identifier: 'user1',
        password: 'correct-password',
      } as any);

      expect(result).not.toBeNull();
      expect(result!.accessToken).toEqual(expect.any(String));
      expect(result!.refreshToken).toEqual(expect.any(String));
      expect(result!.user.id).toBe('user-1');
      // Never leak the raw refresh token anywhere but the dedicated field.
      expect(JSON.stringify(result!.user)).not.toContain(result!.refreshToken);
      expect(prisma.refresh_tokens.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ user_id: 'user-1' }),
        }),
      );
    });

    it('throws Unauthorized on wrong password', async () => {
      const passwordHash = await bcryptHash('correct-password', 10);
      prisma.users.findFirst.mockResolvedValue({
        ...baseUser,
        password_hash: passwordHash,
      });

      await expect(
        service.login({
          identifier: 'user1',
          password: 'wrong-password',
        } as any),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.refresh_tokens.create).not.toHaveBeenCalled();
    });

    it('throws Unauthorized when the user does not exist', async () => {
      prisma.users.findFirst.mockResolvedValue(null);

      await expect(
        service.login({
          identifier: 'ghost',
          password: 'whatever',
        } as any),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('register', () => {
    it('always creates a client account, ignoring any client-supplied role', async () => {
      prisma.users.create.mockResolvedValue({
        ...baseUser,
        role: UserRole.client,
      });
      prisma.refresh_tokens.create.mockResolvedValue({ id: 'session-new' });

      // Cast to bypass the DTO type (which no longer even has a `role` field) to prove
      // the service itself ignores it, in case an unvalidated field ever slips through.
      const result = await service.register({
        email: 'new@example.com',
        username: 'newuser',
        password: 'password123',
        name: 'New User',
        role: 'admin',
      } as any);

      // register() now auto-logs-in the new user (see AuthService.register), matching
      // the frontend's expectation of the same session shape as /auth/login.
      expect(result).not.toBeNull();
      expect(result!.accessToken).toEqual(expect.any(String));
      expect(result!.refreshToken).toEqual(expect.any(String));
      expect(prisma.users.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: UserRole.client }),
        }),
      );
      expect(prisma.users.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ role: 'admin' }),
        }),
      );
    });
  });

  describe('verifyAccessToken', () => {
    it('accepts a token it signed and returns the RequestUser it encodes', () => {
      const jwt = new JwtService({ secret: TEST_JWT_SECRET });
      const token = jwt.sign({
        sub: 'user-1',
        role: 'venue',
        venue_id: 'venue-1',
      });

      const result = service.verifyAccessToken(token);

      expect(result).toEqual({
        id: 'user-1',
        role: 'venue',
        venue_id: 'venue-1',
      });
    });

    it('rejects an expired token', () => {
      const jwt = new JwtService({ secret: TEST_JWT_SECRET });
      const token = jwt.sign(
        { sub: 'user-1', role: 'client', venue_id: null },
        { expiresIn: '-1s' },
      );

      expect(() => service.verifyAccessToken(token)).toThrow(
        UnauthorizedException,
      );
    });

    it('rejects a token signed with a different secret', () => {
      const jwt = new JwtService({ secret: 'a-totally-different-secret' });
      const token = jwt.sign({ sub: 'user-1', role: 'client', venue_id: null });

      expect(() => service.verifyAccessToken(token)).toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('refreshSession', () => {
    it('throws when no token is presented', async () => {
      await expect(service.refreshSession(undefined)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws on an unknown token', async () => {
      prisma.refresh_tokens.findUnique.mockResolvedValue(null);

      await expect(service.refreshSession('unknown-raw-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws on an expired token', async () => {
      prisma.refresh_tokens.findUnique.mockResolvedValue({
        id: 'rt-1',
        user_id: 'user-1',
        family_id: 'family-1',
        revoked_at: null,
        expires_at: new Date(Date.now() - 1000),
      });

      await expect(service.refreshSession('expired-raw-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('rotates a valid token: revokes the old row and issues a new one in the same family', async () => {
      prisma.refresh_tokens.findUnique.mockResolvedValue({
        id: 'rt-1',
        user_id: 'user-1',
        family_id: 'family-1',
        revoked_at: null,
        expires_at: new Date(Date.now() + 60_000),
      });
      prisma.users.findUnique.mockResolvedValue(baseUser);
      prisma.refresh_tokens.create.mockResolvedValue({ id: 'rt-2' });
      prisma.refresh_tokens.update.mockResolvedValue({});

      const result = await service.refreshSession('valid-raw-token');

      expect(result.accessToken).toEqual(expect.any(String));
      expect(result.refreshToken).toEqual(expect.any(String));
      expect(prisma.refresh_tokens.update).toHaveBeenCalledWith({
        where: { id: 'rt-1' },
        data: { revoked_at: expect.any(Date), replaced_by: 'rt-2' },
      });
      expect(prisma.refresh_tokens.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ family_id: 'family-1' }),
        }),
      );
    });

    it('reuse detection: presenting an already-rotated token revokes the whole family', async () => {
      prisma.refresh_tokens.findUnique.mockResolvedValue({
        id: 'rt-1',
        user_id: 'user-1',
        family_id: 'family-1',
        revoked_at: new Date(), // already rotated/revoked once
        expires_at: new Date(Date.now() + 60_000),
      });
      prisma.refresh_tokens.updateMany.mockResolvedValue({ count: 2 });

      await expect(service.refreshSession('reused-raw-token')).rejects.toThrow(
        UnauthorizedException,
      );

      expect(prisma.refresh_tokens.updateMany).toHaveBeenCalledWith({
        where: { family_id: 'family-1', revoked_at: null },
        data: { revoked_at: expect.any(Date) },
      });
      // Reuse must not mint a fresh session.
      expect(prisma.refresh_tokens.create).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the matching refresh token', async () => {
      prisma.refresh_tokens.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.logout('some-raw-token');

      expect(result).toEqual({ success: true });
      expect(prisma.refresh_tokens.updateMany).toHaveBeenCalledWith({
        where: { token_hash: expect.any(String), revoked_at: null },
        data: { revoked_at: expect.any(Date) },
      });
    });

    it('is a no-op (but still succeeds) when no token is presented', async () => {
      const result = await service.logout(undefined);

      expect(result).toEqual({ success: true });
      expect(prisma.refresh_tokens.updateMany).not.toHaveBeenCalled();
    });

    it('a refresh after logout is rejected (session actually invalidated)', async () => {
      // logout() marks the row revoked in the DB; refreshSession() must now see it as
      // already-revoked and treat re-presenting it as reuse, not accept it.
      prisma.refresh_tokens.updateMany.mockResolvedValue({ count: 1 });
      await service.logout('logged-out-token');

      prisma.refresh_tokens.findUnique.mockResolvedValue({
        id: 'rt-1',
        user_id: 'user-1',
        family_id: 'family-1',
        revoked_at: new Date(),
        expires_at: new Date(Date.now() + 60_000),
      });

      await expect(service.refreshSession('logged-out-token')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  describe('session management', () => {
    it('lists only active, non-expired sessions for the user', async () => {
      prisma.refresh_tokens.findMany.mockResolvedValue([
        {
          id: 's1',
          created_at: new Date(),
          expires_at: new Date(),
          user_agent: null,
          ip: null,
        },
      ]);

      const sessions = await service.listSessions('user-1');

      expect(sessions).toHaveLength(1);
      expect(prisma.refresh_tokens.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user_id: 'user-1',
            revoked_at: null,
          }),
        }),
      );
    });

    it('revokes a session owned by the caller', async () => {
      prisma.refresh_tokens.findUnique.mockResolvedValue({
        id: 'session-1',
        user_id: 'user-1',
        revoked_at: null,
      });
      prisma.refresh_tokens.update.mockResolvedValue({});

      const result = await service.revokeSessionById('user-1', 'session-1');

      expect(result).toEqual({ success: true });
      expect(prisma.refresh_tokens.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { revoked_at: expect.any(Date) },
      });
    });

    it('refuses to revoke a session owned by a different user', async () => {
      prisma.refresh_tokens.findUnique.mockResolvedValue({
        id: 'session-1',
        user_id: 'someone-else',
        revoked_at: null,
      });

      await expect(
        service.revokeSessionById('user-1', 'session-1'),
      ).rejects.toThrow('Session not found');
      expect(prisma.refresh_tokens.update).not.toHaveBeenCalled();
    });

    it('revokes all sessions for a user ("logout everywhere")', async () => {
      prisma.refresh_tokens.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.revokeAllSessions('user-1');

      expect(result).toEqual({ success: true });
      expect(prisma.refresh_tokens.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user_id: 'user-1',
            revoked_at: null,
          }),
        }),
      );
    });
  });

  describe('resetPassword single-use', () => {
    it('rejects a reset token that was already redeemed', async () => {
      const jwt = new JwtService({ secret: TEST_JWT_SECRET });
      const resetToken = jwt.sign(
        { sub: 'user-1', type: 'password_reset', jti: 'jti-1' },
        { expiresIn: '15m' },
      );

      const duplicateKeyError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '5.22.0' },
      );
      prisma.used_password_reset_tokens.create.mockRejectedValue(
        duplicateKeyError,
      );

      await expect(
        service.resetPassword(resetToken, 'brand-new-password'),
      ).rejects.toThrow('Token reset già utilizzato');
      expect(prisma.users.update).not.toHaveBeenCalled();
    });
  });
});
